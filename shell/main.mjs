import { BrowserWindow, Menu, WebContentsView, app, dialog, ipcMain, nativeImage, nativeTheme, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_DIR } from '../filemanager.js'
import { IS_MAC, IS_WINDOWS } from '../platform.js'
import { adoptTarget, parseLaunchArgs, parseLaunchRequest, routeLaunch } from './host.mjs'
import { isExternalWebUrl, isLoopbackUrl, isWebUrl, parseTabAction, parseTrayState, sameOrigin } from './model.mjs'
import { dataUrl, resolveDark, stoppedPage } from './pages.mjs'
import { BrowserTabs } from './tabs.mjs'

/**
 * 由原生外壳（launcher/ 的 Rust 窗口）按需拉起的 Electron 窗口宿主。它只做 dsh 页面的窗口：
 * 一个标签窗口（多标签条）+ 最多一个独立窗口（单页）。服务、控制面板、托盘、应用菜单、窗口按钮
 * 都不在这里——那些归原生外壳；Electron 只在用户选了「内部标签页 / 独立窗口」时才会被下载并拉起。
 *
 * 启动契约（原生外壳按这个拉起，两个平台一致）：
 *   <electron 可执行文件> <app 目录> --tab <地址> [--title <标题>]   在标签窗口里开 / 切到一个标签
 *   <electron 可执行文件> <app 目录> --window <地址>                独立窗口打开一页
 *   <electron 可执行文件> <app 目录> --show                        把已有窗口叫到前面
 * 单实例锁：第二次拉起的进程只把参数交给已有实例（Electron 的 second-instance 通道），自己退出。
 * 进程内不再跑服务，所以没有「关窗口 ≠ 退出」：窗口全关就是退出，原生外壳和 dsh 实例都不受影响。
 *
 * 管理服务地址由环境变量 DSH_MANAGER_URL 给（http://127.0.0.1:<端口>/）：语言、主题、
 * 实例列表（也就是标签的标题与地址）都靠轮询它的 /api/tray 得到。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
/** 标签条本地页与预加载脚本：只给窗口自己的 webContents 用，远端 dsh 页面拿不到。 */
const STRIP_FILE = join(HERE, 'strip.html')
const PRELOAD = join(HERE, 'preload.cjs')
const ICON_FILE = join(ROOT, 'assets', 'icon.png')
/** 和 preload.cjs 的 IPC_CHANNEL 一致。 */
const IPC_CHANNEL = 'dsh-x:ipc'
/** 标签条高度（逻辑像素），必须和 shell/strip.html 的 .strip 高度一致：内容层从这条线下面开始。 */
const TAB_STRIP_HEIGHT = 44
/** 轮询 /api/tray 的间隔（和旧托盘一致）：标签标题、语言、主题、实例地址都跟着它走。 */
const TRAY_POLL_MS = 1500
const TRAY_REQUEST_TIMEOUT_MS = 2000
/** 标签窗口与独立窗口的首次尺寸（逻辑像素），沿用旧外壳。 */
const TAB_WINDOW = { width: 1200, height: 840, minWidth: 720, minHeight: 520 }
const DSH_WINDOW = { width: 1180, height: 820, minWidth: 720, minHeight: 520 }
/** 窗口底色：和标签条 / 停止页的两套配色一致，缩放时不闪白。 */
const WINDOW_BACKGROUND = { light: '#eef3fd', dark: '#15171c' }
/** 页面进程崩溃时 Chromium 报的原因：这几种是正常结束，不用重装。 */
const CLEAN_EXITS = new Set(['clean-exit', 'killed'])
/** dsh 页面能申请的权限：只放行本机地址的麦克风 / 摄像头（询问用户），其余一律拒绝。 */
const MEDIA_PERMISSION = 'media'

let managerBase = ''
let state = parseTrayState('')
let tabWindow = null
let tabs = null
let standalone = null
let quitting = false

// 浏览器数据（cookie、站点权限、缓存）放在每用户目录下，和旧版外壳同一份：升级上来的用户不用
// 重新登录 dsh。必须在 ready 与单实例锁之前设——单实例锁按 userData 定位。
// （Electron 默认的 userData 按应用名算，源码运行时会落到「Electron」名下，不能用。）
app.setName('DSH')
app.setPath('userData', join(APP_DIR, 'electron'))

const launch = parseLaunchArgs(process.argv)

// 第二实例靠单实例锁把「这次要开什么」递给主实例。不能只靠 second-instance 的 commandLine：
// macOS 上 Chromium 会把它重排成「先所有开关、后所有位置参数」，--tab 和它的地址会被拆开。
// requestSingleInstanceLock 的 additionalData 是 Electron 给这条通道准备的（macOS / Windows 都支持）。
const handoff = launch.request ? { launch: launch.request } : { launchError: launch.error }

if (!app.requestSingleInstanceLock(handoff)) {
  // 第二个进程：参数已经随单实例锁递给了主实例，这里直接退。
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData) => {
    // 首选 additionalData（同版本外壳一定带）；commandLine 只在版本错位时兜底，它可能已被重排，
    // 能认出来的只有 --show 这种不带值的开关，--tab 的参数会拆开。
    const carried = additionalData?.launch
    const result = carried ? parseLaunchRequest(carried) : parseLaunchArgs(commandLine)
    if (!result.request) {
      const reason = additionalData?.launchError || result.error
      console.error(`DSH-X 标签窗口：忽略无效的第二实例参数（${reason}）`)
      return
    }
    // 主实例可能还在等第一次状态轮询：等 ready 之后再动窗口（whenReady 已就绪时只是下一拍）。
    app.whenReady().then(() => applyLaunch(result.request)).catch((error) => {
      console.error(`DSH-X 标签窗口：处理第二实例参数失败：${error?.stack || error}`)
    })
  })
  app.whenReady().then(start).catch((error) => {
    console.error(`DSH-X 标签窗口启动失败：${error?.stack || error}`)
    app.exit(1)
  })
}

async function start() {
  if (launch.error) {
    console.error(`DSH-X 标签窗口：${launch.error}`)
    console.error('用法：<electron> <app目录> --tab <地址> [--title <标题>] | --window <地址> | --show')
    app.exit(2)
    return
  }
  // Windows 的任务栏分组要用 AppUserModelID；和原生外壳用同一个，两个进程在任务栏里是一组。
  if (IS_WINDOWS) app.setAppUserModelId('io.github.yyh-001.dsh-x')
  // Windows 的默认应用菜单会给每个窗口加一条菜单栏；标签窗口没有菜单，直接去掉。
  // macOS 留着系统菜单：没有它 ⌘Q / 复制粘贴 / 窗口切换都没有快捷键。
  if (!IS_MAC) Menu.setApplicationMenu(null)
  // 原始 Electron 的 Dock 图标是「Electron」的原子图标：换成启动器自己的，别让用户以为开错了应用。
  if (IS_MAC && existsSync(ICON_FILE)) app.dock?.setIcon(nativeImage.createFromPath(ICON_FILE))
  installPermissionHandlers()
  installDownloadHandler()
  // 系统深浅色在运行中变了（控制中心切换）：停止页和标签条跟着重画（#58）
  nativeTheme.on('updated', () => {
    tabs?.systemThemeChanged()
    refreshStandalone()
  })

  managerBase = managerBaseFromEnv()
  // 首个进程只有 --show：没有任何窗口可叫。原生外壳在窗口已经关掉之后还留着旧状态时会这样拉一次，
  // 这不是错误（下次 --tab 会重新建窗口），安静退出。
  if (!launch.request.tab && !launch.request.window) {
    console.error('DSH-X 标签窗口：没有可显示的窗口（--show 只对已经开着的窗口有效）')
    app.exit(0)
    return
  }
  // 先取一次状态：启动信号里的地址能直接对上实例 id，标签一开始就是「托管」状态（标题会跟着改）。
  await refreshState()
  applyLaunch(launch.request)
  applyState()
  // 没有管理服务地址就没有可轮询的东西（标签照常开，只是标题 / 主题不跟随）。
  if (managerBase) schedulePoll()
}

/** 管理服务地址由原生外壳通过环境变量给出；缺了标签页也还能开，只是标题 / 主题不跟随。 */
function managerBaseFromEnv() {
  const raw = String(process.env.DSH_MANAGER_URL || '').trim()
  if (!raw) {
    console.error('DSH-X 标签窗口：没有 DSH_MANAGER_URL，标签标题和主题不会跟随启动器')
    return ''
  }
  if (!isLoopbackUrl(raw)) {
    console.error(`DSH-X 标签窗口：DSH_MANAGER_URL 不是本机地址（${raw}），忽略`)
    return ''
  }
  return raw.endsWith('/') ? raw : `${raw}/`
}

/** 问一次 /api/tray。服务刚起来 / 正在重启时保留上一次的状态，下一轮再问。 */
async function refreshState() {
  if (!managerBase) return
  try {
    const res = await fetch(`${managerBase}api/tray`, { signal: AbortSignal.timeout(TRAY_REQUEST_TIMEOUT_MS) })
    state = parseTrayState(await res.text())
  } catch { /* 下一轮再问 */ }
}

function schedulePoll() {
  if (quitting) return
  setTimeout(async () => {
    if (quitting) return
    await refreshState()
    applyState()
    schedulePoll()
  }, TRAY_POLL_MS)
}

/** 当前该用深色还是浅色：设置里显式指定就听它的，system 跟随系统（#58）。 */
function currentDark() {
  return resolveDark(state.theme, nativeTheme.shouldUseDarkColors)
}

/** 状态轮询到了：窗口底色、标签条语言 / 主题、标签跟随、独立窗口跟随。 */
function applyState() {
  const background = currentDark() ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
  tabWindow?.setBackgroundColor(background)
  standalone?.setBackgroundColor(background)
  tabs?.preferences(state.lang, state.theme)
  tabs?.follow(state.instances)
  refreshStandalone()
}

/**
 * 原生外壳传来的一次启动请求（可能来自首个进程，也可能是 second-instance 转来的）。
 * 同一实例重复打开只切过去；独立窗口只有一扇，已经开着就换页。
 */
function applyLaunch(request) {
  const actions = routeLaunch(request, {
    tabWindow: Boolean(tabWindow),
    tabs: tabs?.snapshot() || [],
    window: Boolean(standalone),
  })
  if (actions.selectTab) tabs.action({ action: 'select', id: actions.selectTab })
  if (actions.openTab) {
    ensureTabWindow()
    tabs.open(tabTargetFor(actions.openTab.url, actions.openTab.title))
  }
  if (actions.openWindow) showStandalonePage(actions.openWindow.url)
  if (actions.followWindow) showStandalonePage(request.window.url)
  if (!actions.show) return
  if (actions.openWindow || actions.followWindow) showStandalone()
  else if (tabWindow) showTabWindow()
  else if (standalone) showStandalone()
}

/**
 * 地址 → 标签目标。能在实例列表里对上（按 origin）就用实例自己的身份与标题；
 * 轮询还没看到这个实例（刚启动的 dsh、端口还没进状态）时先按地址建一个「未托管」标签，
 * 下一次 tabs.follow 会按地址认领到实例上，标题与重启跟随从那时起生效。
 */
function tabTargetFor(url, title = '') {
  const instance = adoptTarget(url, state.instances)
  if (instance) return { ...instance, title: title || instance.title }
  return { id: url, title: title || 'DSH', url, status: 'running', managed: false }
}

function localPreferences() {
  return { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
}

/** 远端 dsh 页面：不装预加载，拿不到任何外壳通道。 */
function remotePreferences() {
  return { sandbox: true, contextIsolation: true, nodeIntegration: false }
}

function ensureTabWindow() {
  if (tabWindow) return
  tabWindow = new BrowserWindow({
    ...TAB_WINDOW,
    title: 'DSH',
    show: false,
    backgroundColor: currentDark() ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
    ...(IS_WINDOWS ? { icon: ICON_FILE } : {}),
    webPreferences: localPreferences(),
  })
  tabWindow.on('resize', () => tabs?.layout())
  tabWindow.on('closed', () => {
    tabWindow = null
    tabs = null
  })
  tabs = new BrowserTabs(tabWindow, {
    createView: () => createTabView(),
    systemDark: () => nativeTheme.shouldUseDarkColors,
    stripHeight: TAB_STRIP_HEIGHT,
  })
  // 先把语言 / 主题灌进去再开标签：标签条页就绪前的 render 可能延后落地，不能让它带着
  // 「浅色 + 中文」的默认值先画出来（深色主题下会闪一下白）。
  tabs.preferences(state.lang, state.theme)
  tabWindow.once('ready-to-show', () => tabWindow?.show())
  // 标签条页就绪前的 render 是空跑：这里补一次完整状态（已开的标签、选中态、语言、主题）。
  tabWindow.loadFile(STRIP_FILE).then(() => {
    tabs?.preferences(state.lang, state.theme)
    tabs?.follow(state.instances)
    tabs?.render(true)
  }).catch((error) => console.error(`DSH-X 标签窗口：标签条加载失败：${error?.message || error}`))
}

function createTabView() {
  const view = new WebContentsView({ webPreferences: remotePreferences() })
  wirePage(view.webContents, { kind: 'tab', view })
  return view
}

function ensureStandalone() {
  if (standalone) return
  standalone = new BrowserWindow({
    ...DSH_WINDOW,
    title: 'DSH',
    show: false,
    backgroundColor: currentDark() ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
    ...(IS_WINDOWS ? { icon: ICON_FILE } : {}),
    webPreferences: remotePreferences(),
  })
  standalone.page = ''
  standalone.rendered = ''
  standalone.instanceId = null
  standalone.on('closed', () => { standalone = null })
  wirePage(standalone.webContents, { kind: 'window', view: null })
}

/** 独立窗口打开一个地址：能对上实例就记住实例身份，之后它重启换端口还能跟上。 */
function showStandalonePage(url) {
  ensureStandalone()
  const target = tabTargetFor(url)
  standalone.instanceId = target.managed ? target.id : null
  followStandalonePage(target.url)
}

/**
 * 独立窗口跟随它打开时那个实例：地址没变不刷新（别把用户正在看的页面刷掉），
 * 实例停了换停止页（空地址），语言 / 主题变了停止页要重画。
 */
function followStandalonePage(url) {
  if (!standalone) return
  const page = url || ''
  const placeholder = dataUrl(stoppedPage(state.lang, currentDark()))
  const rendered = page || placeholder
  if (standalone.page === page && standalone.rendered === rendered) return
  standalone.page = page
  standalone.rendered = rendered
  if (!page) standalone.setTitle('DSH')
  standalone.webContents.loadURL(rendered).catch(() => {})
}

function refreshStandalone() {
  if (!standalone) return
  // 轮询比打开窗口晚一点：先按地址认出这扇窗口跟的是哪个实例；认领不到就一直当普通地址页。
  if (!standalone.instanceId && standalone.page) {
    const adopted = adoptTarget(standalone.page, state.instances)
    if (adopted) standalone.instanceId = adopted.id
  }
  const target = standalone.instanceId ? state.instances.find((item) => item.id === standalone.instanceId) : null
  const live = target && target.url && (target.status === 'running' || target.status === 'starting')
  followStandalonePage(live ? target.url : (standalone.instanceId ? '' : standalone.page))
}

/** 窗口里所有页面共用的事件接线：弹窗、导航、标题、快捷键、崩溃恢复。 */
function wirePage(contents, { kind, view }) {
  contents.setWindowOpenHandler(({ url }) => {
    // 同一个 dsh 的弹窗留在本标签 / 本窗口里；别的地址交给分派。
    if (view && tabs?.linkByView(view, url)) return { action: 'deny' }
    if (kind === 'window' && standalone?.page && sameOrigin(url, standalone.page)) {
      followStandalonePage(url)
      return { action: 'deny' }
    }
    openPageLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    // 本机地址（dsh 自己、它的插件页）和页面自己的东西都放行；只有真正的外部网页交给系统浏览器。
    if (!isExternalWebUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  contents.on('page-title-updated', (event, title) => {
    if (view) {
      // 标签的页面标题由标签条统一画，窗口标题在 tabs.render 里同步。
      tabs?.titleByView(view, title)
      return
    }
    // 独立窗口的标题跟页面走：否则窗口切换器里永远只有一个「DSH」。
    event.preventDefault()
    standalone?.setTitle(String(title).trim() || 'DSH')
  })
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return
    const key = String(input.key).toLowerCase()
    if (key === 'r') {
      event.preventDefault()
      contents.reload()
      return
    }
    if (key === 'w') {
      // 标签窗口里 ⌘W / Ctrl+W 先关当前标签；没有标签可关（或这是独立窗口）才关窗口。
      event.preventDefault()
      if (kind === 'tab' && tabs?.selected) closeActiveTab()
      else windowOf(contents, kind)?.close()
      return
    }
    if (key === 'tab' && kind === 'tab' && tabs?.tabs.length) {
      event.preventDefault()
      tabs.action({ action: 'next' })
    }
  })
  contents.on('render-process-gone', (_event, details) => {
    if (CLEAN_EXITS.has(details.reason)) return
    // 页面进程崩了只剩一块空白：标签由外壳重新认证装回，独立窗口重新加载当前地址。
    if (view) tabs?.recoverByView(view)
    else if (standalone?.page) followStandalonePage(standalone.page)
  })
}

/** 页面里点出来的链接 / 弹窗：属于某个 dsh 实例的走标签窗口，其余 http(s) 交给系统浏览器。 */
function openPageLink(url) {
  if (!isWebUrl(url)) return
  const instance = adoptTarget(url, state.instances)
  if (instance) {
    if (tabWindow) {
      tabs.open({ ...instance })
      showTabWindow()
      return
    }
    if (standalone) {
      // 独立窗口进程只服务它自己那一页：别的实例交给浏览器，不硬塞进当前窗口。
      if (standalone.instanceId === instance.id) followStandalonePage(instance.url)
      else shell.openExternal(instance.url)
      return
    }
    shell.openExternal(instance.url)
    return
  }
  // 外部网页和认不出的本机地址（管理页等）都交给系统浏览器，别把窗口导走。
  if (isExternalWebUrl(url) || isLoopbackUrl(url)) shell.openExternal(url)
}

function windowOf(contents, kind) {
  return kind === 'tab' ? tabWindow : BrowserWindow.fromWebContents(contents) || standalone
}

function showTabWindow() {
  if (!tabWindow) return
  if (tabWindow.isMinimized()) tabWindow.restore()
  tabWindow.show()
  tabWindow.focus()
}

function showStandalone() {
  if (!standalone) return
  if (standalone.isMinimized()) standalone.restore()
  standalone.show()
  standalone.focus()
}

/** 标签条页发来的标签操作（window.ipc.postMessage → preload → 这里）。别的 sender 一律不认。 */
ipcMain.on(IPC_CHANNEL, (event, message) => {
  if (!tabWindow || event.sender !== tabWindow.webContents) return
  const action = parseTabAction(message)
  if (!action) return
  if (action.action === 'close-tab' || action.action === 'close-active') closeActiveTab(action.id)
  else tabs?.action(action)
})

/**
 * 关标签。最后一个标签关掉之后这扇窗口就没有内容可显示了——直接关窗（进程没有托盘，
 * 窗口全关就退出）；不把一扇空标签条窗口留在桌面上。
 */
function closeActiveTab(id) {
  if (!tabs) return
  tabs.action(id === undefined ? { action: 'close-active' } : { action: 'close-tab', id })
  if (tabs.tabs.length === 0) tabWindow?.close()
}

function ownerWindow(contents) {
  return BrowserWindow.fromWebContents(contents) || tabWindow || standalone || null
}

/**
 * 权限：dsh 的语音输入要麦克风。只放行本机地址的 media 请求，并用原生对话框问一次；
 * 其余权限（通知、地理位置……）一律拒绝——这些页面都是本机工具，不需要。
 */
function installPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = details.requestingUrl || contents.getURL()
    // 复制按钮（诊断信息等）走异步剪贴板 API，Chromium 会请求这个权限；
    // 一律拒绝的话 writeText 直接失败，页面只能退回「选中再复制」那条死路。
    if (permission === 'clipboard-sanitized-write' && isLoopbackUrl(origin)) {
      callback(true)
      return
    }
    if (permission !== MEDIA_PERMISSION || !isLoopbackUrl(origin)) {
      callback(false)
      return
    }
    const camera = details.mediaTypes?.includes('video')
    const en = state.lang === 'en'
    const device = en ? (camera ? 'camera' : 'microphone') : (camera ? '摄像头' : '麦克风')
    let host = origin
    try { host = new URL(origin).origin } catch { /* data: 页之类：原样显示 */ }
    const options = {
      type: 'question',
      buttons: en ? ['Allow', 'Deny'] : ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      message: en ? `${host} wants to use your ${device}.` : `${host} 请求使用${device}。`,
      detail: en ? 'Allow access?' : '是否允许？',
    }
    const owner = ownerWindow(contents)
    const answer = owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)
    answer.then(({ response }) => callback(response === 0), () => callback(false))
  })
}

/**
 * 页面里的下载（导出日志等）：Electron 不会自己存文件，没人接管 will-download 时下载会被
 * 静默丢掉（浏览器版没这问题）。这里问一次保存路径再写盘。
 */
function installDownloadHandler() {
  session.defaultSession.on('will-download', async (_event, item, contents) => {
    const owner = ownerWindow(contents)
    const options = { defaultPath: join(app.getPath('downloads'), item.getFilename() || 'dsh-download') }
    try {
      const { canceled, filePath } = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      if (canceled || !filePath) {
        item.cancel()
        return
      }
      item.setSavePath(filePath)
    } catch {
      item.cancel()
    }
  })
}

// 窗口全关就退出：这个进程没有托盘也没有服务，留着只会占一个单实例锁。
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { quitting = true })
// 程序坞图标：窗口被关掉之前点它，把最后那扇窗口叫回来（macOS 的系统行为）
app.on('activate', () => {
  if (tabWindow) showTabWindow()
  else if (standalone) showStandalone()
})
