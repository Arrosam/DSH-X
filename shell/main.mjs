// 必须是第一个 import：它在 platform.js / server.js 求值之前补好 PATH 和外壳标记（见 env.mjs）
import './env.mjs'
import { BrowserWindow, Menu, Tray, WebContentsView, app, dialog, ipcMain, nativeImage, nativeTheme, session, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IS_MAC, IS_WINDOWS, RUNTIME_NODE } from '../platform.js'
import { APP_DIR } from '../filemanager.js'
import { BrowserTabs } from './tabs.mjs'
import { dataUrl, errorPage, idlePage } from './pages.mjs'
import {
  LAUNCH_ACTIONS,
  internalMode,
  isExternalWebUrl,
  isLoopbackUrl,
  isWebUrl,
  launchActionEnabled,
  launchActionRequest,
  launchLabel,
  parseTabAction,
  parseTrayState,
  sameOrigin,
  windowMode,
} from './model.mjs'

/**
 * Windows / macOS 的 DSH-X 外壳（Electron）。Windows 和 macOS 安装包里都是这一套：
 * 管理页、内部标签页、独立 DSH 窗口都跑在 Chromium 里，和官方 DSH 桌面端同一个内核。
 * launcher/ 那份 Rust + WKWebView/WebView2 外壳只剩安装引擎（DSH-Setup）在用。
 *
 * 和 Rust 外壳最大的不同：管理服务（server.js）不再是子进程，而是跑在本进程里。所以
 * - 「把窗口叫出来 / 开标签 / 开窗口」不再走 stdout 标记行，而是 setHost 换成直接调用；
 * - 退出时先让服务收尾（停 dsh、通知页面），再退出 Electron（见 quit）。
 * dsh 子进程用 RUNTIME_NODE 拉起（platform.js）：源码运行是系统 node，打包后是 Electron 本体
 * 加 ELECTRON_RUN_AS_NODE=1——这样不用再随包塞一份 node.exe（省 80MB+）。
 *
 * 关窗口 ≠ 退出：托盘还在、dsh 照常跑；⌘Q、托盘「退出」才真正退出。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PRELOAD = join(HERE, 'preload.cjs')
/** 和 preload.cjs 的 IPC_CHANNEL 一致。 */
const IPC_CHANNEL = 'dsh-x:ipc'
/**
 * 管理页的 window 查询参数：macOS 用它切到红绿灯排版（public/index.html 的 macWindow），
 * Windows 则固定用 '1'——和 Rust/wry 外壳一致，页面据此画自绘的最小化/最大化/关闭按钮。
 */
const WINDOW_QUERY = IS_MAC ? 'mac' : '1'
/** 首次出现的窗口尺寸（逻辑像素），和 Rust 外壳一致。 */
const MAIN_WINDOW = { width: 1100, height: 760, minWidth: 720, minHeight: 520 }
const DSH_WINDOW = { width: 1180, height: 820, minWidth: 720, minHeight: 520 }
const ERROR_WINDOW = { width: 560, height: 300, logHeight: 420 }
/**
 * 红绿灯的位置（逻辑像素，左上角为原点）：Rust 外壳给 tao 的 inset 是 (18, 29)，tao 把它当成
 * 「按钮左边距、标题栏高度 = 按钮高 + 29」，按钮因此竖直居中在 (14 + 29) / 2 ≈ 21.5 上。
 * Electron 的 trafficLightPosition 是按钮左上角，换算后 y = 21.5 - 7 ≈ 15，和页面顶栏的竖直中线对齐。
 */
const TRAFFIC_LIGHTS = { x: 18, y: 15 }
/** 托盘轮询 /api/tray 的间隔：和 Rust 外壳一致。 */
const TRAY_POLL_MS = 1500
const TRAY_REQUEST_TIMEOUT_MS = 2000
/** 托盘里的启动 / 修复可能很慢，后台等它，不卡菜单。 */
const TRAY_ACTION_TIMEOUT_MS = 120_000
/** 菜单栏 / 托盘图标按 18pt（macOS）或 16px（Windows 托盘）显示，给 2 倍图才不糊。 */
const TRAY_ICON_POINTS = IS_MAC ? 18 : 16
const ICON_FILE = join(ROOT, 'assets', 'icon.png')
/** 页面进程崩溃时 Chromium 报的原因：这几种是正常结束，不用重装。 */
const CLEAN_EXITS = new Set(['clean-exit', 'killed'])
/** dsh 页面能申请的权限：只放行本机地址的麦克风 / 摄像头（询问用户），其余一律拒绝。 */
const MEDIA_PERMISSION = 'media'

let server = null
/** 管理页的根地址（http://127.0.0.1:<端口>/）：端口被占时服务会顺延，以 startServer 返回的为准。 */
let managerBase = ''
let mainWindow = null
let tabs = null
let dshWindow = null
let tray = null
let trayMenuKey = ''
let state = parseTrayState('')
let quitting = false

/** 启动器版本：源码运行（npm run electron）时 app.getVersion() 是 Electron 的版本，所以自己读。 */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

// 浏览器数据（cookie、站点权限、缓存）放在每用户目录下，和 Rust 外壳的 DSH/webview 并排；
// 不用 Electron 默认的 ~/Library/Application Support/<应用名>——源码运行时那个名字是「Electron」。
// 必须在 ready 和单实例锁之前设：两者都按 userData 定位。
app.setPath('userData', join(APP_DIR, 'electron'))

/** 先占单实例锁：第二次打开只把已有实例的窗口叫出来（对应 Rust 外壳的 find_manager + /api/wake）。 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showManager())
  app.whenReady().then(start).catch((error) => showStartupError('DSH-X 启动失败', '外壳初始化时出错。', error?.stack || String(error)))
}

function managerUrl() {
  return managerBase
}

async function start() {
  // Windows 的任务栏分组 / 通知要用 AppUserModelID；macOS 没有这个概念（bundle id 在 Info.plist 里）
  if (IS_WINDOWS) app.setAppUserModelId('io.github.yyh-001.dsh-x')
  if (IS_MAC) app.setAboutPanelOptions({ applicationName: 'DSH-X', applicationVersion: VERSION })
  console.log(`DSH-X ${VERSION} (Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`)
  // macOS 需要应用菜单提供 ⌘Q / 复制粘贴；Windows 的页面里 Ctrl+C/V 由 Chromium 自己处理，
  // 没有「窗口菜单」这回事，干脆不要菜单栏（Rust 外壳也没有）。
  if (IS_MAC) Menu.setApplicationMenu(appMenu())
  else Menu.setApplicationMenu(null)
  installPermissionHandlers()
  installDownloadHandler()
  // 系统深浅色在运行中变了（控制中心切换）：停止页跟着重画（#58）
  nativeTheme.on('updated', () => tabs?.systemThemeChanged())

  // 源码运行时 RUNTIME_NODE 来自 PATH 上的 node；打包后永远是 Electron 本体（process.execPath），
  // 只有旧安装包（带 node/node.exe）或显式 DSH_RUNTIME_NODE 指歪了才可能落空。
  if (!RUNTIME_NODE || (app.isPackaged && !existsSync(RUNTIME_NODE))) {
    showStartupError('启动器文件不完整', '找不到用来运行 dsh 的 node。', '重新安装一次 DSH-X 即可。')
    return
  }

  // 管理服务直接在本进程里起。端口被占时它自己顺延；被自己的另一个实例占着会抛 EALREADY——
  // 单实例锁已经挡掉了同一个包的第二个实例，走到这里说明是别的副本（源码运行、Windows 版不会
  // 在 macOS 上），那就唤醒它然后安静退出，和 start.js 的处理一致。
  server = await import('../server.js')
  try {
    managerBase = `${await server.startServer()}/`
  } catch (error) {
    if (error?.code === 'EALREADY') {
      await fetch(`http://127.0.0.1:${error.port}/api/wake`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(TRAY_REQUEST_TIMEOUT_MS) }).catch(() => {})
      app.exit(0)
      return
    }
    showStartupError('dsh 服务启动失败', '管理页没能起来。', error?.stack || String(error))
    return
  }
  server.setHost({
    onWake: async () => showManager(),
    openTab: (target) => openInternalTab(target),
    openWindow: (url) => openDshWindow(url),
    exit: (code) => exitApp(code),
  })

  createMainWindow()
  createTray()
  pollTray()
}

/** 启动失败：在自己的小窗口里把原因说清楚，关掉就退出（不留一个没人管的托盘）。 */
function showStartupError(title, message, detail) {
  const height = String(detail).split('\n').length > 2 ? ERROR_WINDOW.logHeight : ERROR_WINDOW.height
  const window = new BrowserWindow({
    width: ERROR_WINDOW.width, height, resizable: false, title: 'DSH-X',
    // 出错窗口没画窗口按钮：macOS 用 hiddenInset，Windows 保留系统边框（不然关不掉）
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { icon: ICON_FILE }),
    backgroundColor: '#15171c',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  window.on('closed', () => app.exit(1))
  window.loadURL(dataUrl(errorPage(title, message, detail)))
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    ...MAIN_WINDOW,
    title: 'DSH-X',
    show: false,
    // macOS 留着系统红绿灯（用户对它们的肌肉记忆比风格统一更重要），标题栏透明、页面铺满整个窗口；
    // Windows 没有红绿灯：无边框，最小化/最大化/关闭由页面画（.app-window 的 win-controls）
    ...(IS_MAC
      ? { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS }
      : { frame: false, icon: ICON_FILE, backgroundColor: '#15171c' }),
    webPreferences: managerPreferences(),
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', (event) => {
    // 关窗口不退出：托盘还在、dsh 照常跑，需要时从托盘或程序坞再叫回来
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('resize', () => tabs?.layout())
  guardManager(mainWindow.webContents)
  tabs = new BrowserTabs(mainWindow, { createView: createTabView })
  mainWindow.loadURL(`${managerUrl()}?window=${WINDOW_QUERY}`)
}

/** 管理页和独立窗口那张本地页：只有它们装预加载、拿得到 window.ipc。 */
function managerPreferences() {
  return { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
}

/** 远端 dsh 页面：不装预加载，拿不到任何外壳通道。 */
function remotePreferences() {
  return { sandbox: true, contextIsolation: true, nodeIntegration: false }
}

/**
 * 管理页的链接与导航：只放行管理页自己。外部链接（Star、运行地址、更新日志）交给分派——
 * 选了内部标签 / 桌面窗口时，「运行地址」要进外壳而不是浏览器。就地导航会把窗口导走、
 * 连红绿灯旁边的顶栏一起弄丢，所以一律拦下。
 */
function guardManager(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(managerUrl())) return
    event.preventDefault()
    if (isWebUrl(url)) openLink(url)
  })
  contents.on('before-input-event', (event, input) => {
    // ⌘W / ⌃Tab 在显示标签条时归标签页（和 Rust 外壳注入的 keydown 脚本同一组快捷键）
    if (!tabs?.active) return
    const action = shortcutAction(input, false)
    if (action) {
      event.preventDefault()
      tabs.action({ action })
    }
  })
  contents.on('render-process-gone', (_event, details) => {
    if (!CLEAN_EXITS.has(details.reason)) contents.reload()
  })
}

/**
 * 标签页 / 管理页的快捷键 → 标签操作。在主进程的 before-input-event 里判，不往远端页面注入脚本：
 * 远端页面不该能伪造这些操作，也不该因为我们的脚本吞掉它自己的按键。
 * ⌘R 只在标签页里接管（管理页的 ⌘R 由应用菜单的 Reload 处理）。
 */
function shortcutAction(input, inTab) {
  if (input.type !== 'keyDown' || !(input.meta || input.control)) return null
  const key = input.key.toLowerCase()
  if (key === 'tab') return 'next'
  if (key === 'w') return 'close-active'
  if (key === 'r' && inTab) return 'reload'
  return null
}

function createTabView(id) {
  const view = new WebContentsView({ webPreferences: remotePreferences() })
  const contents = view.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (!tabs.link(id, url)) openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    // 本机地址（dsh 自己、它的插件页）和页面自己的东西都放行；只有真正的外部网页交给系统浏览器
    if (!isExternalWebUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  contents.on('page-title-updated', (_event, title) => tabs.title(id, title))
  contents.on('before-input-event', (event, input) => {
    const action = shortcutAction(input, true)
    if (action) {
      event.preventDefault()
      tabs.action({ action })
    }
  })
  // 页面进程崩了只剩一块空白：由外壳重新认证装回（见 BrowserTabs.recover）
  contents.on('render-process-gone', (_event, details) => {
    if (!CLEAN_EXITS.has(details.reason)) tabs.recover(id)
  })
  return view
}

/** 管理页和本地页发来的消息（window.ipc.postMessage）。按发送方分派，别的 webContents 发的一律不认。 */
ipcMain.on(IPC_CHANNEL, (event, message) => {
  if (mainWindow && event.sender === mainWindow.webContents) return handleManagerMessage(message)
  // 独立窗口里远端 dsh 页面也带着这个预加载（同一块 webContents 换页，预加载改不了）：
  // 只认外壳自己那张 data: 本地页发的消息
  if (dshWindow && event.sender === dshWindow.webContents && event.senderFrame?.url.startsWith('data:')) return handleIdleMessage(message)
})

function handleManagerMessage(message) {
  switch (message) {
    // macOS 用系统红绿灯：最小化 / 最大化 / 关闭按钮页面不画（.mac-window 隐藏了），这里照样接住
    case 'minimize': mainWindow.minimize(); return
    case 'maximize': toggleMaximize(mainWindow); return
    case 'close': mainWindow.hide(); return
    // 拖窗口走 CSS 的 -webkit-app-region（public/launcher.css 的 .electron-window header）：Chromium 没有
    // 「从页面里发起一次系统拖动」的接口，页面在 mousedown 时发的 drag 这里无事可做
    case 'drag': return
    case 'internal-tabs-ready': tabs.render(true); return
    default: {
      const action = parseTabAction(message)
      if (action) tabs.action(action)
    }
  }
}

function toggleMaximize(window) {
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
}

function showManager() {
  if (!mainWindow) return
  tabs?.action({ action: 'select', id: '' })
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 内部标签页：复用主窗口。主窗口不在（极少见）就退回系统浏览器，至少还能访问已经起来的实例。 */
function openInternalTab(target) {
  if (!mainWindow) {
    shell.openExternal(target.url)
    return
  }
  tabs.open(target)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
}

/**
 * 页面里点出来的链接：管理页自己 → 叫回管理页；属于某个 dsh 实例 → 按打开方式进标签 / 独立窗口；
 * 其余 http(s) 交给系统浏览器。data:/blob: 不是能给系统打开的地址，宁可不理。
 */
function openLink(url) {
  if (sameOrigin(url, managerUrl())) {
    showManager()
    return
  }
  const own = state.instances.find((target) => target.url && sameOrigin(url, target.url))
  if (internalMode(state) && own) {
    openInternalTab(own)
    return
  }
  if (windowMode(state) && own) {
    // 本机链接可能没有 token，使用这个实例自己的完整认证地址
    openDshWindow(own.url)
    return
  }
  if (isWebUrl(url)) shell.openExternal(url)
}

/** 独立 DSH 窗口：按需创建，关窗口只是藏起来（和主窗口一个口径）。 */
function openDshWindow(url) {
  if (!dshWindow) createDshWindow()
  dshWindow.instanceId = null
  followDshWindow(url)
  if (dshWindow.isMinimized()) dshWindow.restore()
  dshWindow.show()
  dshWindow.focus()
}

function createDshWindow() {
  dshWindow = new BrowserWindow({
    ...DSH_WINDOW,
    title: 'DSH',
    show: false,
    ...(IS_WINDOWS ? { icon: ICON_FILE } : {}),
    // 本地那张「没在跑」的页要 window.ipc；远端 dsh 页面的预加载只暴露 postMessage，
    // 而 handleIdleMessage 只认 launch / manager 两个词，dsh 页面发什么都没有效果
    webPreferences: managerPreferences(),
  })
  dshWindow.page = null
  dshWindow.instanceId = null
  dshWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    dshWindow.hide()
  })
  const contents = dshWindow.webContents
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isExternalWebUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  // 网页标题同步到窗口标题：否则窗口菜单里永远只有一个「DSH」
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    dshWindow.setTitle(title.trim() || 'DSH')
  })
  contents.on('render-process-gone', (_event, details) => {
    if (CLEAN_EXITS.has(details.reason) || !dshWindow.page) return
    const url = dshWindow.page
    dshWindow.page = null
    followDshWindow(url)
  })
}

/** 让独立窗口跟上 dsh 的当前地址；地址没变不刷新（别把用户正在看的页面刷掉），空地址换本地页。 */
function followDshWindow(url) {
  const page = url || ''
  if (dshWindow.page === page) return
  dshWindow.page = page
  const target = page || dataUrl(idlePage(state.lang))
  dshWindow.webContents.loadURL(target).catch(() => {})
}

function handleIdleMessage(message) {
  // 只有本地那张页会发这两个；dsh 自己的页面发什么都不管
  if (message === 'manager') {
    showManager()
    return
  }
  if (message !== 'launch') return
  const row = state.launches.find((item) => item.instanceId && item.instanceId === dshWindow.instanceId)
  if (row) trayAction({ id: row.id, instanceId: row.instanceId, action: 'start', targetId: '' })
  // 原来的入口已被删除时，返回启动器选择，不能误启动另一项
  else showManager()
}

/**
 * 应用菜单。没有它 ⌘Q / ⌘C / ⌘V 不灵。「退出」不用系统预设项：那会绕过管理服务的收尾
 * （停 dsh、通知页面），所以换成自己的项、走和托盘同一条路。⌘W 只是把窗口藏起来。
 */
function appMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'DSH-X',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit DSH-X', accelerator: 'Command+Q', click: () => quit() },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'togglefullscreen' },
        { label: 'Close Window', accelerator: 'Command+W', click: (_item, window) => closeWindow(window) },
      ],
    },
  ])
}

/**
 * ⌘W：标签条显示时由管理页 / 标签页的 before-input-event 先接住（关标签）；
 * 走到菜单这里说明没有标签可关，就把当前窗口藏起来。
 */
function closeWindow(window) {
  window?.hide()
}

function createTray() {
  const image = nativeImage.createFromPath(ICON_FILE).resize({ width: TRAY_ICON_POINTS, height: TRAY_ICON_POINTS, quality: 'best' })
  tray = new Tray(image)
  tray.setToolTip('DSH-X')
  // Windows 托盘点左键叫回管理页（右键才是菜单）；macOS 点菜单栏图标默认弹菜单，不抢。
  if (IS_WINDOWS) tray.on('click', () => showManager())
  syncTrayMenu()
}

/** 菜单只在内容变化时重建，轮询不会把用户正展开的子菜单拆掉。 */
function syncTrayMenu() {
  if (!tray) return
  const en = state.lang === 'en'
  const key = JSON.stringify([en, state.launches.map((row) => [row.id, launchLabel(row, en), LAUNCH_ACTIONS.map(({ action }) => launchActionEnabled(row, action))])])
  if (key === trayMenuKey) return
  trayMenuKey = key
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: en ? 'Open DSH-X' : '打开启动器', click: () => showManager() },
    { type: 'separator' },
    ...state.launches.map((row) => ({
      label: launchLabel(row, en),
      submenu: LAUNCH_ACTIONS.map(({ action, zh, en: english }) => ({
        label: en ? english : zh,
        enabled: launchActionEnabled(row, action),
        click: () => {
          const body = launchActionRequest(row, action)
          if (body) trayAction(body)
        },
      })),
    })),
    { type: 'separator' },
    { label: en ? 'Quit' : '退出', click: () => quit() },
  ]))
}

/** 每隔一会儿问一次状态：托盘文案、标签页、独立窗口都跟着它走。 */
async function pollTray() {
  try {
    const res = await fetch(`${managerUrl()}api/tray`, { signal: AbortSignal.timeout(TRAY_REQUEST_TIMEOUT_MS) })
    applyState(parseTrayState(await res.text()))
  } catch { /* 下一轮再问 */ }
  if (!quitting) setTimeout(pollTray, TRAY_POLL_MS)
}

function applyState(next) {
  state = next
  syncTrayMenu()
  // dsh 重启后地址（端口、token）会变：独立窗口跟着选中的实例换页，不能被后来启动的另一项抢走
  if (dshWindow) {
    if (!dshWindow.instanceId && dshWindow.page) {
      dshWindow.instanceId = state.instances.find((target) => sameOrigin(target.url, dshWindow.page))?.id || null
    }
    if (dshWindow.instanceId) {
      const target = state.instances.find((item) => item.id === dshWindow.instanceId)
      followDshWindow(target?.url || '')
    }
  }
  if (tabs) {
    tabs.preferences(internalMode(state), state.lang, state.theme)
    tabs.follow(state.instances)
  }
}

/** 托盘的启动项操作：后台请求，失败就把管理页叫出来、用页面自己的提示说明原因。 */
async function trayAction(body) {
  const en = state.lang === 'en'
  let error = ''
  try {
    const res = await fetch(`${managerUrl()}api/tray/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TRAY_ACTION_TIMEOUT_MS),
    })
    if (!res.ok) error = (await res.json().catch(() => ({}))).error || (en ? 'Tray action failed. Check the logs.' : '托盘操作失败，请查看日志')
  } catch {
    error = en ? 'Unable to reach DSH-X. Check the logs.' : '无法连接启动器，请查看日志'
  }
  if (!error) return
  showManager()
  mainWindow?.webContents.executeJavaScript(`notify(${JSON.stringify(error)})`).catch(() => {})
}

/**
 * 权限：dsh 的语音输入要麦克风。只放行本机地址的 media 请求，并用原生对话框问一次；
 * 其余权限（通知、地理位置……）一律拒绝——这些页面都是本机工具，不需要。
 */
function installPermissionHandlers() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = details.requestingUrl || contents.getURL()
    // 复制按钮（诊断信息等）走异步剪贴板 API，Chromium 会请求这个权限；
    // 一律拒绝的话 writeText 直接失败，页面只能退回「选中再复制」那条死路
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
    const host = new URL(origin).origin
    const owner = BrowserWindow.fromWebContents(contents) || mainWindow
    dialog.showMessageBox(owner, {
      type: 'question',
      buttons: en ? ['Allow', 'Deny'] : ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      message: en ? `${host} wants to use your ${device}.` : `${host} 请求使用${device}。`,
      detail: en ? 'Allow access?' : '是否允许？',
    }).then(({ response }) => callback(response === 0), () => callback(false))
  })
}

/**
 * 页面里的下载（导出日志等）：Electron 不会自己存文件，没人接管 will-download 时下载会被
 * 静默丢掉（浏览器版没这问题）。这里问一次保存路径再写盘，完成/失败在页面上给个提示。
 */
function installDownloadHandler() {
  session.defaultSession.on('will-download', async (event, item, contents) => {
    const owner = BrowserWindow.fromWebContents(contents) || mainWindow
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(owner, {
        defaultPath: join(app.getPath('downloads'), item.getFilename() || 'dsh-x-download'),
      })
      if (canceled || !filePath) {
        item.cancel()
        return
      }
      item.setSavePath(filePath)
      item.once('done', (_event, status) => {
        if (contents.isDestroyed()) return
        const en = state.lang === 'en'
        const message = status === 'completed' ? (en ? `Saved to ${filePath}` : `已保存到 ${filePath}`)
          : status === 'cancelled' ? '' : (en ? 'Download failed' : '下载失败')
        if (message) contents.executeJavaScript(`notify(${JSON.stringify(message)})`).catch(() => {})
      })
    } catch {
      item.cancel()
    }
  })
}

/** 托盘「退出」/ ⌘Q：交给管理服务收尾，它收完调 host.exit（见 exitApp）。 */
async function quit() {
  if (quitting) return
  if (!server) {
    app.exit(0)
    return
  }
  await fetch(`${managerUrl()}api/quit`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(TRAY_REQUEST_TIMEOUT_MS) })
    .catch(() => server.shutdown().finally(() => exitApp(0)))
}

/** 管理服务收尾之后（退出 / 自更新）真正退出：先放行窗口的 close，再让 Electron 退。 */
function exitApp(code = 0) {
  quitting = true
  app.exit(code)
}

// 程序坞图标：窗口藏起来之后点它，叫回管理页
app.on('activate', () => showManager())
// 系统也能直接结束我们（程序坞右键「退出」、注销关机）：先让服务停掉 dsh，否则 dsh 子进程会留下来
app.on('before-quit', (event) => {
  if (quitting || !server) return
  event.preventDefault()
  quit()
})
// 窗口全关了也不退：托盘还在（默认行为在 macOS 上本来就不退，这里写明白）
app.on('window-all-closed', () => {})

