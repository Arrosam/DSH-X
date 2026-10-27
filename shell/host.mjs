import { isLoopbackUrl, isWebUrl, sameOrigin } from './model.mjs'

/**
 * 标签窗口宿主的纯逻辑：解析原生外壳传进来的启动参数、决定第二次拉起的进程要干什么、
 * 标签怎么跟随 /api/tray 的实例列表。与 Electron 无关，node --test 直接跑
 * （见 test/shell-host.test.mjs）。
 *
 * 启动契约（原生外壳按这个拉起 Electron，两个平台一致）：
 *   <electron 可执行文件> <app 目录> --tab <地址> [--title <标题>]
 *   <electron 可执行文件> <app 目录> --window <地址>
 *   <electron 可执行文件> <app 目录> --show
 *
 * 一个进程只有一个标签窗口、最多一个独立窗口：第二次拉起的进程靠 Electron 的单实例锁把
 * 这几组参数交给已有进程（second-instance 的 commandLine），自己退出。所以这里只做「参数 →
 * 动作」的换算，不碰窗口和 Electron API。
 */

export const LAUNCH_FLAGS = { show: '--show', tab: '--tab', window: '--window', title: '--title' }

/** 标签页只能开本机 dsh 地址：认证 token 只在本机管道里传，不往外部网页送。 */
function launchUrl(value, flag) {
  if (!value) return { url: '', error: `${flag} 后面缺少页面地址` }
  if (!isWebUrl(value) || !isLoopbackUrl(value)) return { url: '', error: `${flag} 只接受本机 http(s) 地址：${value}` }
  return { url: value, error: '' }
}

/**
 * 命令行参数 → { request, error }。只认自己的四个标志，其余参数（Electron / Chromium 自己的
 * 开关、可执行文件与 app 目录）一律跳过——原生外壳和命令行都会顺手带一些。
 * request: { show, tab: { url, title } | null, window: { url } | null }
 */
export function parseLaunchArgs(argv) {
  const args = (Array.isArray(argv) ? argv : []).map(String)
  const raw = { show: false, tab: null, window: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === LAUNCH_FLAGS.show) {
      raw.show = true
      continue
    }
    if (arg === LAUNCH_FLAGS.tab || arg === LAUNCH_FLAGS.window) {
      const url = args[index + 1]
      if (!url || url.startsWith('--')) return { request: null, error: `${arg} 后面缺少页面地址` }
      if (arg === LAUNCH_FLAGS.tab) raw.tab = { url, title: '' }
      else raw.window = { url }
      index += 1
      continue
    }
    if (arg === LAUNCH_FLAGS.title) {
      const title = args[index + 1]
      // 标题是可选的：空串当作没给；有值时必须修饰刚给的那个标签（--title 只跟在 --tab 后面）。
      if (typeof title !== 'string' || title.startsWith('--')) return { request: null, error: '--title 后面缺少标题' }
      if (title) {
        if (!raw.tab) return { request: null, error: '--title 只能修饰 --tab 打开的标签' }
        raw.tab.title = title
      }
      index += 1
    }
  }
  return parseLaunchRequest(raw)
}

/**
 * 校验一个「启动请求」对象（不带命令行）。第二实例正是把它塞进 requestSingleInstanceLock 的
 * additionalData 交给主实例的：macOS 上 second-instance 给的 commandLine 会被 Chromium 重新
 * 排成「先所有开关、后所有位置参数」的形状（--tab 和它的地址被拆开），命令行不能作为通道。
 */
export function parseLaunchRequest(raw) {
  if (!raw || typeof raw !== 'object') return { request: null, error: '没有 --tab / --window / --show 参数' }
  const request = { show: raw.show === true, tab: null, window: null }
  if (raw.tab !== undefined && raw.tab !== null) {
    const { url, error } = launchUrl(typeof raw.tab === 'object' ? raw.tab.url : '', '--tab')
    if (error) return { request: null, error }
    request.tab = { url, title: typeof raw.tab.title === 'string' ? raw.tab.title : '' }
  }
  if (raw.window !== undefined && raw.window !== null) {
    const { url, error } = launchUrl(typeof raw.window === 'object' ? raw.window.url : '', '--window')
    if (error) return { request: null, error }
    request.window = { url }
  }
  if (!request.tab && !request.window && !request.show) return { request: null, error: '没有 --tab / --window / --show 参数' }
  return { request, error: '' }
}

/**
 * 请求 → 已有窗口该做的事。state 是主进程此刻的现状：
 *   { tabWindow: boolean, tabs: [{ id, url }], window: boolean }
 * 返回：
 *   show         要不要把窗口叫到前面（只有 --show 而没有窗口时什么都不做）
 *   selectTab    切到哪个已有标签（同一实例重复打开不新开一页）
 *   openTab      要新开的标签目标 { url, title }
 *   openWindow   要新开的独立窗口 { url }
 *   followWindow 独立窗口已经开着：换页，不再开第二扇
 */
export function routeLaunch(request, state = {}) {
  const actions = { show: false, selectTab: '', openTab: null, openWindow: null, followWindow: false }
  if (request.tab) {
    const existing = (state.tabs || []).find((tab) => tab.url && sameOrigin(tab.url, request.tab.url))
    if (existing) actions.selectTab = existing.id
    else actions.openTab = { url: request.tab.url, title: request.tab.title || '' }
    actions.show = true
  }
  if (request.window) {
    if (state.window) actions.followWindow = true
    else actions.openWindow = { url: request.window.url }
    actions.show = true
  }
  if (!actions.show && request.show) actions.show = Boolean(state.tabWindow || state.window)
  return actions
}

/** 实例列表里按认证地址认出「这个地址是哪个实例」；对不上返回 null。 */
export function adoptTarget(url, instances = []) {
  if (!url) return null
  return instances.find((item) => item.managed !== false && item.url && sameOrigin(item.url, url)) || null
}

/**
 * 一个标签该跟到哪个地址（'/' 表示实例已停、显示停止页），以及更新后的目标。
 * 标题就从实例列表同步过来：启动项改名、dsh 重启后都会在下一次轮询生效。
 * 未托管的标签（启动时实例还没进轮询结果）保持用户打开的地址，不换成停止页——
 * 认领到实例之前不能拿「查不到 id」当成「实例停了」。
 */
export function followTarget(target, instances = []) {
  if (!target || target.managed === false) return { target: { ...target }, url: target?.url || '' }
  const next = instances.find((item) => item.id === target.id)
  const live = next && (next.status === 'running' || next.status === 'starting')
  return { target: next || { ...target, status: 'stopped' }, url: live ? next.url : '' }
}
