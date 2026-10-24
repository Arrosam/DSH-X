// 这个目录是可选外壳：Electron 本体由启动器在运行时下载（见 electron.js），
// 这里只有几 KB 源码，随安装包一起发。
//
// 没有 "type": "module"：Electron 主进程按 CommonJS 加载 .js，和仓库其它地方的 ESM 无关。
const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron')
const { join } = require('node:path')
const { isLocalUrl, tabKeyFromArgv, urlFromArgv } = require('./url.js')

/** 标签条的高度，和 tabs.html 里的 CSS 对齐。 */
const HEADER_HEIGHT = 44
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

const tabs = []
let window = null
let strip = null

function layout() {
  if (!window) return
  const { width, height } = window.getContentBounds()
  for (const tab of tabs) {
    tab.view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(height - HEADER_HEIGHT, 0) })
  }
}

/** 把当前标签列表同步给标签条；页面只拿标题和状态，拿不到带 token 的地址。 */
function render() {
  if (!strip) return
  strip.webContents.send('tabs', tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    active: tab.active,
  })))
}

function select(id) {
  for (const tab of tabs) {
    tab.active = tab.id === id
    tab.view.setVisible(tab.active)
  }
  layout()
  render()
}

function close(id) {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const [tab] = tabs.splice(index, 1)
  window.contentView.removeChildView(tab.view)
  tab.view.webContents.close()
  if (tabs.length === 0) {
    window.close()
    return
  }
  select((tabs[index] || tabs[index - 1] || tabs[0]).id)
}

function open(url, key = '') {
  if (!isLocalUrl(url)) return
  ensureWindow()
  // 一个实例只留一个标签：dsh 重启换了端口或 token 就地换页，不另开一个，
  // 否则重启几次就满屏标签。身份由启动器给（--tab=），拿不到就退回按 origin 认。
  const origin = new URL(url).origin
  const id = key || origin
  const existing = tabs.find((tab) => tab.key === id)
  if (existing) {
    if (existing.view.webContents.getURL() !== url) existing.view.webContents.loadURL(url)
    select(existing.id)
    window.show()
    return
  }
  const view = new WebContentsView({ webPreferences: { sandbox: true } })
  const tab = { id: `${Date.now()}-${tabs.length}`, key: id, title: 'DSH', view, active: false }
  tabs.push(tab)
  window.contentView.addChildView(view)
  view.webContents.on('page-title-updated', (_event, title) => {
    tab.title = title || 'DSH'
    render()
  })
  // 页面里点出去的外部链接交给系统浏览器：这个窗口只装 dsh 自己
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isLocalUrl(target)) {
      open(target)
    } else if (/^https?:/i.test(target)) {
      void shell.openExternal(target)
    }
    return { action: 'deny' }
  })
  view.webContents.loadURL(url)
  select(tab.id)
  window.show()
}

function ensureWindow() {
  if (window && !window.isDestroyed()) return window
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'DSH-X',
    backgroundColor: process.env.DSH_THEME === 'dark' ? '#1b1d21' : '#ffffff',
    webPreferences: { preload: join(__dirname, 'preload.js') },
  })
  strip = window
  window.loadFile(join(__dirname, 'tabs.html'), {
    query: { theme: process.env.DSH_THEME || 'light', lang: process.env.DSH_LANG || 'zh' },
  })
  window.on('resize', layout)
  window.on('closed', () => {
    for (const tab of tabs.splice(0)) tab.view.webContents.close()
    window = null
    strip = null
  })
  return window
}

// 单实例：再起一次等于「把这个地址开成一个标签」，启动器每次打开都直接 spawn 自己，
// 不用再维护一条 IPC 通道。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = urlFromArgv(argv)
    if (url) open(url, tabKeyFromArgv(argv))
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  app.whenReady().then(() => {
    ipcMain.on('tab', (_event, message) => {
      const { action, id } = message || {}
      if (action === 'select') select(id)
      else if (action === 'close') close(id)
      else if (action === 'reload') {
        const tab = tabs.find((item) => item.active)
        if (tab) tab.view.webContents.reload()
      }
    })
    ipcMain.on('ready', render)
    const url = urlFromArgv(process.argv)
    if (url) open(url, tabKeyFromArgv(process.argv))
    else ensureWindow().show()
  })

  app.on('window-all-closed', () => app.quit())
}
