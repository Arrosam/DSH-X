import { WebContentsView } from 'electron'
import { dataUrl, stoppedPage } from './pages.mjs'
import { reorderBy, sameOrigin } from './model.mjs'

/**
 * 「DSH-X 内部标签页」：每个 dsh 实例一块独立的 WebContentsView，叠在管理页（窗口自己的 webContents）
 * 之上、菜单栏之下。不用 iframe：避免跨源嵌入限制，切换也不会重载会话、不丢草稿。
 *
 * 状态机逐条照搬 Rust 外壳的 launcher/tabs.rs（BrowserTabs），管理页那一侧（public/internal-tabs.js）
 * 不用改：选中、排序都带请求编号，只有管理页画完、回执 present(serial) 之后才切换原生视图的可见性，
 * 中间始终有完整内容，不露出底层。
 */

/** 管理页还没报告菜单栏高度之前用的默认值（逻辑像素），和 tabs.rs 的 HEADER_HEIGHT 一致。 */
const DEFAULT_HEADER_HEIGHT = 72
/** 标签页标题的长度上限：标题来自远端页面，不能无限长地塞进菜单栏。 */
const PAGE_TITLE_MAX = 160

export class BrowserTabs {
  /**
   * @param {import('electron').BrowserWindow} window 主窗口；manager 就是它的 webContents
   * @param {object} hooks 外壳提供的行为：
   *   createView(id) → WebContentsView 的事件接线（标题、链接、导航、崩溃、快捷键）由外壳负责
   */
  constructor(window, hooks) {
    this.window = window
    this.manager = window.webContents
    this.hooks = hooks
    this.tabs = []
    this.selected = ''
    this.enabled = false
    this.lang = 'zh'
    this.theme = 'system'
    this.rendered = ''
    this.headerHeight = DEFAULT_HEADER_HEIGHT
    this.geometry = ''
    this.presentation = 0
    this.renderedSelection = ''
    this.selectionRequest = null
    this.orderRequest = null
    // 关闭当前标签时先保留旧画面，替代页面显示后再释放原生视图。
    this.retired = []
    // 管理页有弹窗开着：原生标签页总叠在管理页之上，弹窗画不过它，只能先把标签页收起来。
    this.overlay = false
  }

  /** 菜单栏里是不是正显示着标签条（管理页的快捷键只在这时接管 ⌘W / ⌃Tab）。 */
  get active() {
    return this.enabled || this.tabs.length > 0
  }

  preferences(enabled, lang, theme) {
    this.enabled = enabled
    this.lang = lang
    this.theme = theme
    this.layout()
    this.render(false)
  }

  tabBounds() {
    const { width, height } = this.window.getContentBounds()
    return { x: 0, y: this.headerHeight, width, height: Math.max(0, height - this.headerHeight) }
  }

  layout() {
    const bounds = this.tabBounds()
    const geometry = JSON.stringify(bounds)
    if (geometry === this.geometry) return
    this.geometry = geometry
    for (const tab of [...this.tabs, ...this.retired]) tab.view.setBounds(bounds)
  }

  present(serial) {
    // 快速连点产生的旧绘制回执不能把页面切回去。只响应最新一次选择。
    if (serial !== this.presentation) return
    // 弹窗开着时按「选中管理页」呈现：露出完整弹窗，在任何标签下都能直接关掉；弹窗关了原样放回。
    const shown = this.overlay ? '' : this.selected
    const tab = this.tabs.find((item) => item.target.id === shown)
    // 先显示新页面，后隐藏旧页面；两者之间始终有完整内容，不露出管理页底层。
    if (tab && !tab.visible) {
      tab.view.setVisible(true)
      tab.visible = true
    }
    for (const item of [...this.tabs, ...this.retired]) {
      if (item.visible && item.target.id !== shown) {
        item.view.setVisible(false)
        item.visible = false
      }
    }
    for (const item of this.retired) this.destroy(item)
    this.retired = []
    if (shown) tab?.view.webContents.focus()
    else this.manager.focus()
  }

  open(target) {
    let tab = this.tabs.find((item) => item.target.id === target.id)
    if (!tab) {
      const view = this.hooks.createView(target.id)
      view.setVisible(false)
      view.setBounds(this.tabBounds())
      this.window.contentView.addChildView(view)
      tab = { target, view, loaded: '', pageTitle: '', visible: false }
      this.tabs.push(tab)
    }
    if (tab.loaded !== target.url) {
      this.load(tab, target.url)
      tab.loaded = target.url
    }
    this.selected = target.id
    tab.target = target
    this.layout()
    this.render(false)
  }

  /** 导航失败（ERR_ABORTED 之类）由页面自己显示，这里只防未处理的 Promise。 */
  load(tab, url) {
    tab.view.webContents.loadURL(url).catch(() => {})
  }

  action(request) {
    switch (request.action) {
      case 'select':
        if ('request' in request) this.selectionRequest = request.request
        if (!request.id || this.tabs.some((tab) => tab.target.id === request.id)) this.selected = request.id
        break
      case 'reorder':
        if (this.orderRequest !== null && request.request <= this.orderRequest) return
        this.tabs = reorderBy(this.tabs, request.ids, (tab) => tab.target.id)
        this.orderRequest = request.request
        break
      case 'close-tab':
        this.close(request.id)
        break
      case 'close-active':
        this.close(this.selected)
        break
      case 'next': {
        const index = this.tabs.findIndex((tab) => tab.target.id === this.selected)
        this.selected = this.tabs[index + 1]?.target.id ?? ''
        break
      }
      case 'reload': {
        const tab = this.tabs.find((item) => item.target.id === this.selected)
        if (tab) tab.view.webContents.reload()
        else this.manager.reload()
        break
      }
      case 'layout':
        this.headerHeight = request.height
        this.layout()
        return
      case 'present':
        this.present(request.serial)
        return
      case 'overlay':
        if (this.overlay === request.open) return
        this.overlay = request.open
        // 换一个呈现序号，走同一条「管理页画完再回执」的路径切换可见性，不另开一套显示逻辑。
        this.render(true)
        return
      default:
        return
    }
    this.layout()
    this.render(false)
  }

  close(id) {
    const index = this.tabs.findIndex((tab) => tab.target.id === id)
    if (index < 0) return
    // 只释放页面，不向服务端发 stop；关闭标签不等于关闭正在运行的 DSH 实例。
    this.retired.push(...this.tabs.splice(index, 1))
    if (this.selected === id) this.selected = this.tabs[Math.max(0, index - 1)]?.target.id ?? ''
  }

  destroy(tab) {
    this.window.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }

  /** 跟上实例列表：重启换了端口 / token 就换地址，停了就换成本地提示页。 */
  follow(instances) {
    for (const tab of this.tabs) {
      if (!tab.target.managed) continue
      const next = instances.find((item) => item.id === tab.target.id)
      const url = next && (next.status === 'running' || next.status === 'starting') ? next.url : ''
      if (tab.loaded !== url) {
        // 不在占用的旧端口上反复刷新，以免重启间隙误加载到另一个实例。
        this.load(tab, url || dataUrl(stoppedPage(this.lang, this.theme)))
        tab.loaded = url
        tab.pageTitle = ''
      }
      if (next) tab.target = next
      else tab.target = { ...tab.target, status: 'stopped' }
    }
    this.render(false)
  }

  /**
   * 页面进程崩溃后重新装回这个标签：重新导航到带启动 token 的地址，而不是 reload。
   * token 在这个 dsh 进程的生命周期内一直有效，服务端会重发 cookie 并 303 到主页，
   * 和从管理页「打开」走的是同一条认证路径（原因见 tabs.rs 的 recover：WKWebView 崩溃后
   * reload 不带 SameSite=Strict 的认证 cookie；Chromium 下这条路同样稳妥）。
   */
  recover(id) {
    const tab = this.tabs.find((item) => item.target.id === id)
    // 实例已停止时 loaded 为空，标签上那张停止提示页由下一次 follow 重画，这里不抢。
    if (!tab?.loaded) return
    this.load(tab, tab.loaded)
  }

  title(id, title) {
    const tab = this.tabs.find((item) => item.target.id === id)
    if (!tab) return
    tab.pageTitle = [...String(title)].filter((char) => char >= ' ' && char !== '\u007f').slice(0, PAGE_TITLE_MAX).join('')
    this.render(false)
  }

  /** 标签页里点出来的新窗口链接：同一个 dsh 就在本标签里开，其余交给外壳分派。 */
  link(id, url) {
    const tab = this.tabs.find((item) => item.target.id === id)
    if (!tab || !sameOrigin(url, tab.target.url)) return false
    this.load(tab, url)
    return true
  }

  render(force) {
    if (force || this.presentation === 0 || this.renderedSelection !== this.selected || this.retired.length) {
      this.presentation += 1
      this.renderedSelection = this.selected
    }
    const value = JSON.stringify({
      active: this.selected,
      lang: this.lang,
      theme: this.theme,
      presentation: this.presentation,
      request: this.selectionRequest,
      orderRequest: this.orderRequest,
      enabled: this.active,
      tabs: this.tabs.map((tab) => ({ id: tab.target.id, title: tab.target.title, pageTitle: tab.pageTitle, stopped: !tab.loaded })),
    })
    if (!force && value === this.rendered) return
    this.rendered = value
    this.manager.executeJavaScript(`window.updateInternalTabs?.(${value})`).catch(() => {})
  }
}
