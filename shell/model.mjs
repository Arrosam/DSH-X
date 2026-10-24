/**
 * Electron 外壳里与 Electron 无关的那一半：地址判定、/api/tray 的解析、标签页消息校验、
 * 托盘启动项菜单的可用性。全部是纯函数，node --test 直接测（见 test/shell-model.test.mjs）。
 *
 * 规则逐条照搬旧的 Windows Rust 外壳（launcher/main.rs、tabs.rs、tray.rs；已退役，现只剩安装引擎），
 * 两边语义要一致：管理服务对两个外壳说的是同一套协议。
 */

/** 本机地址的主机名：dsh 的界面、管理页都在回环上；别的一律算外部网页。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** 管理页传来的布局高度只认这个范围（逻辑像素），防止脏值把内容区挤没。 */
export const HEADER_HEIGHT_RANGE = { min: 36, max: 256 }
/** 标签页标题的长度上限：标题来自远端页面，不能无限长地塞进菜单栏。 */
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

/** 启动项（托盘子菜单的一行），对应 /api/tray 的 launches=。 */
export function parseLaunchEntry(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return null
  if (typeof value.name !== 'string' || typeof value.status !== 'string') return null
  return {
    id: value.id,
    instanceId: typeof value.instanceId === 'string' ? value.instanceId : '',
    name: value.name,
    status: value.status,
    installed: value.installed === true,
    busy: value.busy === true,
    target: parseTabTarget(value.target),
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

/** /api/tray 的纯文本 key=value（见 server.js）→ 外壳状态。读不到的字段留默认值。 */
export function parseTrayState(text) {
  const state = { status: '', url: '', installed: false, lang: '', openmode: '', shell: false, theme: '', instances: [], launches: [] }
  for (const line of String(text).split('\n')) {
    const at = line.indexOf('=')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key === 'installed' || key === 'shell') state[key] = value === '1'
    else if (key === 'instances') state.instances = parseJsonList(value, parseTabTarget)
    else if (key === 'launches') state.launches = parseJsonList(value, parseLaunchEntry)
    else if (key in state) state[key] = value
  }
  return state
}

/** 设置里选了「桌面窗口」且确实由外壳托管：dsh 的界面开进独立窗口。 */
export function windowMode(state) {
  return state.openmode === 'window' && state.shell
}

/** 设置里选了「DSH-X 内部标签页」且确实由外壳托管：dsh 的界面开进主窗口的标签页。 */
export function internalMode(state) {
  return state.openmode === 'internal' && state.shell
}

const isRequestSerial = (value) => Number.isSafeInteger(value) && value >= 0

/**
 * 管理页发来的标签页操作（JSON 字符串）→ { action, … }；不认识或字段不合法返回 null。
 * 远端 dsh 页面根本拿不到这条通道（预加载只装在管理页上），这里再校验一遍是防管理页自己的脏数据。
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
    case 'next':
    case 'close-active':
      return { action: value.action }
    case 'layout': {
      const { height } = value
      if (typeof height !== 'number' || height < HEADER_HEIGHT_RANGE.min || height > HEADER_HEIGHT_RANGE.max) return null
      return { action: 'layout', height }
    }
    case 'present':
      return isRequestSerial(value.serial) ? { action: 'present', serial: value.serial } : null
    case 'overlay':
      return typeof value.open === 'boolean' ? { action: 'overlay', open: value.open } : null
    default:
      return null
  }
}

/**
 * 按管理页给的顺序重排：已经关掉的 id 忽略，新开的留在末尾。只排已有对象，不重建视图。
 * 拖动与开关标签可能交错，所以不能假设两边的集合一致。
 */
export function reorderBy(items, ids, idOf) {
  const ranks = new Map(ids.map((id, rank) => [id, rank]))
  return items
    .map((item, index) => ({ item, index, rank: ranks.has(idOf(item)) ? ranks.get(idOf(item)) : ids.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item)
}

/** 托盘里每个启动项的四个操作，顺序即菜单顺序。 */
export const LAUNCH_ACTIONS = [
  { action: 'start', zh: '启动', en: 'Start' },
  { action: 'open', zh: '打开', en: 'Open' },
  { action: 'restart', zh: '重启', en: 'Restart' },
  { action: 'stop', zh: '停止', en: 'Stop' },
]

/** 这一项此刻能不能做这个操作（和旧外壳 tray.rs 的 enabled 一致）。 */
export function launchActionEnabled(entry, action) {
  if (entry.busy || entry.status === 'stopping') return false
  switch (action) {
    case 'start': return entry.installed && entry.status === 'stopped'
    case 'open': return entry.status === 'running' && Boolean(entry.target?.url)
    case 'restart': return entry.installed && entry.status === 'running'
    case 'stop': return entry.status === 'running' || entry.status === 'starting'
    default: return false
  }
}

const LAUNCH_STATUS = {
  running: { zh: '运行中', en: 'Running' },
  starting: { zh: '启动中…', en: 'Starting…' },
  stopping: { zh: '停止中…', en: 'Stopping…' },
}

/** 托盘子菜单的标题：「名称 · 状态」。macOS 菜单不把 & 当快捷键标记，不用转义。 */
export function launchLabel(entry, en) {
  const known = LAUNCH_STATUS[entry.status]
  const status = known ? known[en ? 'en' : 'zh']
    : !entry.installed ? (en ? 'Not installed' : '未安装')
      : (en ? 'Stopped' : '未运行')
  return `${entry.name} · ${status}`
}

/** 托盘点了某一项的某个操作 → 发给 /api/tray/action 的正文。 */
export function launchActionRequest(entry, action) {
  if (!launchActionEnabled(entry, action)) return null
  return { id: entry.id, instanceId: entry.instanceId, action, targetId: entry.target?.id || '' }
}
