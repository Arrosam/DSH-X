/**
 * 标签窗口里与 Electron 无关的那一半：地址判定、/api/tray 的解析、标签条消息校验、标题清洗、
 * 重排。全部是纯函数，node --test 直接测（见 test/shell-model.test.mjs）。
 *
 * 规则逐条照搬旧的 Windows Rust 外壳（launcher/main.rs、tabs.rs、tray.rs；已退役，现只剩安装引擎）
 * 与 Electron 外壳的旧版 model.mjs：管理服务对几个外壳说的是同一套协议，语义要一致。
 */

/** 本机地址的主机名：dsh 的界面都在回环上；别的一律算外部网页。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** 标签页标题的长度上限：标题来自远端页面，不能无限长地塞进标签条和窗口标题。 */
export const PAGE_TITLE_MAX = 160

/** 地址的 host（没有 http(s) scheme 时返回 null）。只做判定用，不规范化。 */
export function urlHost(url) {
  const text = String(url)
  const rest = text.startsWith('http://') ? text.slice(7) : text.startsWith('https://') ? text.slice(8) : null
  if (rest === null) return null
  const authority = rest.split(/[/?#]/)[0].split('@').at(-1)
  // IPv6 字面量：[::1]:9716 → ::1
  if (authority.startsWith('[')) return authority.slice(1).split(']')[0]
  return authority.split(':')[0]
}

export function isLoopbackUrl(url) {
  return LOOPBACK_HOSTS.has(urlHost(url))
}

export function isWebUrl(url) {
  return /^https?:\/\//.test(String(url))
}

/**
 * 真正的外部网页：http(s) 且不是本机。只有这种才交给系统浏览器——about:/data:/blob:
 * 是页面自己的东西，交给系统只会弹「用什么应用打开」的对话框。
 */
export function isExternalWebUrl(url) {
  return isWebUrl(url) && !isLoopbackUrl(url)
}

function originOf(url) {
  const match = /^([^:/?#]+):\/\/([^/?#]+)/.exec(String(url))
  return match ? `${match[1].toLowerCase()}://${match[2].toLowerCase()}` : null
}

/** 两个地址的 scheme://authority 是否相同——认出「这个链接就是 dsh 自己」。 */
export function sameOrigin(a, b) {
  const left = originOf(a)
  return left !== null && left === originOf(b)
}

/** 标签页的目标（一个 dsh 实例）。外部地址一律拒收：认证地址只能指向本机。 */
export function parseTabTarget(value) {
  if (!value || typeof value !== 'object') return null
  const { id, url } = value
  if (typeof id !== 'string' || !id || typeof url !== 'string') return null
  if (url && !isLoopbackUrl(url)) return null
  return {
    id,
    url,
    title: typeof value.title === 'string' ? value.title : 'DSH',
    status: typeof value.status === 'string' ? value.status : 'running',
    managed: typeof value.managed === 'boolean' ? value.managed : true,
  }
}

function parseJsonList(text, parse) {
  try {
    const items = JSON.parse(text)
    return Array.isArray(items) ? items.map(parse).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * /api/tray 的纯文本 key=value（见 server.js）→ 外壳状态。读不到的字段留默认值。
 * 标签窗口只用 instances / lang / theme / openmode；其余标量（status、url、installed、shell）
 * 留给原生外壳自己读，这里照样解析但不依赖。
 */
export function parseTrayState(text) {
  const state = { status: '', url: '', installed: false, lang: '', openmode: '', shell: false, theme: '', instances: [] }
  for (const line of String(text).split('\n')) {
    const at = line.indexOf('=')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key === 'installed' || key === 'shell') state[key] = value === '1'
    else if (key === 'instances') state.instances = parseJsonList(value, parseTabTarget)
    else if (key in state) state[key] = value
  }
  return state
}

/** 页面标题来自远端：去掉控制字符、限长，别让它撑爆标签条或窗口标题。 */
export function normalizePageTitle(title) {
  return [...String(title ?? '')]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .slice(0, PAGE_TITLE_MAX)
    .join('')
}

const isRequestSerial = (value) => Number.isSafeInteger(value) && value >= 0

/**
 * 标签条页（shell/strip.html）发来的操作（JSON 字符串）→ { action, … }；不认识或字段不合法返回 null。
 * 远端 dsh 页面根本拿不到这条通道（预加载只装在标签条页上），这里再校验一遍是防脏数据。
 */
export function parseTabAction(body) {
  let value
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  switch (value.action) {
    case 'select':
      if (typeof value.id !== 'string') return null
      if (!('request' in value)) return { action: 'select', id: value.id }
      return isRequestSerial(value.request) ? { action: 'select', id: value.id, request: value.request } : null
    case 'close-tab':
      return typeof value.id === 'string' ? { action: 'close-tab', id: value.id } : null
    case 'reorder': {
      const { ids } = value
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id)) return null
      if (new Set(ids).size !== ids.length || !isRequestSerial(value.request)) return null
      return { action: 'reorder', ids, request: value.request }
    }
    case 'reload':
      return { action: 'reload' }
    case 'present':
      return isRequestSerial(value.serial) ? { action: 'present', serial: value.serial } : null
    default:
      return null
  }
}

/**
 * 按标签条给的顺序重排：已经关掉的 id 忽略，新开的留在末尾。只排已有对象，不重建视图。
 * 拖动与开关标签可能交错，所以不能假设两边的集合一致。
 */
export function reorderBy(items, ids, idOf) {
  const ranks = new Map(ids.map((id, rank) => [id, rank]))
  return items
    .map((item, index) => ({ item, index, rank: ranks.has(idOf(item)) ? ranks.get(idOf(item)) : ids.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item)
}
