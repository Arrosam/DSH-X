import { adoptTarget, followTarget } from './host.mjs'
import { normalizePageTitle, reorderBy, sameOrigin } from './model.mjs'
import { dataUrl, resolveDark, stoppedPage } from './pages.mjs'

/**
 * 标签窗口里的多标签状态机：每个 dsh 实例一块独立的 WebContentsView，叠在标签条本地页
 * （shell/strip.html，也就是窗口自己的 webContents）下面。不用 iframe：dsh 的 cookie、
 * SPA 状态和插件页都不该被套一层，切换也不重载会话、不丢草稿。
 *
 * 和旧版（标签条画在管理页里）唯一的区别是「谁画标签条」：现在是窗口自己画的本地页。
 * 状态切换仍走同一套回执协议——标签条页画完选中态后回执 present(serial)，主进程才切换原生
 * 视图的可见性，中间始终有完整内容，不露出标签条底下的空白。
 *
 * 与 Electron 有关的三个依赖都从 hooks 进来（建视图、系统深浅色、标签条高度），所以这个类
 * 能在 node --test 里用假视图跑（见 test/shell-host.test.mjs）。
 */

export class BrowserTabs {
  /**
   * @param {import('electron').BrowserWindow} window 标签窗口；它的 webContents 就是标签条页
   * @param {object} hooks
   *   createView() → WebContentsView（标题、链接、导航、崩溃、快捷键的事件接线由外壳负责）
   *   systemDark() → boolean 系统当前是不是深色（主题设置是 system 时用）
   *   stripHeight：标签条占的高度（逻辑像素），内容层从它下面开始
   */
  constructor(window, hooks) {
    this.window = window
    this.strip = window.webContents
    this.hooks = hooks
    this.tabs = []
    this.selected = ''
    this.lang = 'zh'
    this.theme = 'system'
    // 设置里的主题换算出来的实际深浅色：停止页和标签条都是外壳自己画的，跟不了 dsh 页面的 CSS（#58）
    this.dark = false
    this.rendered = ''
    this.geometry = ''
    this.presentation = 0
    this.renderedSelection = ''
    this.selectionRequest = null
    this.orderRequest = null
    // 关闭当前标签时先保留旧画面，替代页面显示后再释放原生视图。
    this.retired = []
  }

  /** 轮询每次都会调；只有语言或配色真的变了才重画停止页，免得反复重载。 */
  preferences(lang, theme) {
    const langChanged = this.lang !== lang
    this.lang = lang
    this.theme = theme
    this.syncPlaceholder(langChanged)
    this.layout()
    this.render(false)
  }

  /** 系统深浅色在运行中变了（控制中心切换）：由外壳的 nativeTheme 'updated' 事件调用。 */
  systemThemeChanged() {
    if (this.syncPlaceholder(false)) this.render(false)
  }

  /** 只动正显示停止页的标签（loaded 为空）：运行中的实例页面有自己的配色，重载会丢掉内容。 */
  syncPlaceholder(langChanged) {
    const dark = resolveDark(this.theme, this.hooks.systemDark())
    if (dark === this.dark && !langChanged) return false
    this.dark = dark
    for (const tab of this.tabs) {
      if (tab.target.managed !== false && !tab.loaded) this.load(tab, '')
    }
    return true
  }

  placeholder() {
    return dataUrl(stoppedPage(this.lang, this.dark))
  }

  tabBounds() {
    const { width, height } = this.window.getContentBounds()
    const top = this.hooks.stripHeight
    return { x: 0, y: top, width, height: Math.max(0, height - top) }
  }

  layout() {
    const bounds = this.tabBounds()
    const geometry = JSON.stringify(bounds)
    if (geometry === this.geometry) return
    this.geometry = geometry
    for (const tab of [...this.tabs, ...this.retired]) tab.view.setBounds(bounds)
  }

  /** 第二实例路由用：现在开着哪些标签、各自代表哪个地址。 */
  snapshot() {
    return this.tabs.map((tab) => ({ id: tab.target.id, url: tab.loaded || tab.target.url }))
  }

  present(serial) {
    // 快速连点产生的旧绘制回执不能把页面切回去，只响应最新一次选择。
    if (serial !== this.presentation) return
    this.reveal()
  }

  /** 先显示新页面，后隐藏旧页面；两者之间始终有完整内容，不露出标签条下面的空白。 */
  reveal() {
    const tab = this.tabs.find((item) => item.target.id === this.selected)
    if (tab && !tab.visible) {
      tab.view.setVisible(true)
      tab.visible = true
    }
    for (const item of [...this.tabs, ...this.retired]) {
      if (item.visible && item.target.id !== this.selected) {
        item.view.setVisible(false)
        item.visible = false
      }
    }
    for (const item of this.retired) this.destroy(item)
    this.retired = []
    if (tab) tab.view.webContents.focus()
    else this.strip.focus()
  }

  open(target) {
    // 先按实例 id 找；id 对不上再按地址认——启动信号里的地址可能比轮询更早到，那时还不知道实例 id。
    let tab = this.tabs.find((item) => item.target.id === target.id)
      || (target.url ? this.tabs.find((item) => item.loaded && sameOrigin(item.loaded, target.url)) : undefined)
    if (!tab) {
      const view = this.hooks.createView()
      view.setVisible(false)
      view.setBounds(this.tabBounds())
      this.window.contentView.addChildView(view)
      // loaded 用 null 表示「还没装过页面」：空串是「实例停了、显示停止页」，两者不能混。
      tab = { target, view, loaded: null, pageTitle: '', visible: false }
      this.tabs.push(tab)
    }
    if (this.selected === tab.target.id) this.selected = target.id
    tab.target = target
    // 只有正在跑 / 正在启动的实例才把地址装进来；停止的实例显示停止页，别去连旧端口。
    const page = target.status === 'running' || target.status === 'starting' ? target.url : ''
    if (tab.loaded !== page) this.load(tab, page)
    this.selected = target.id
    this.layout()
    this.render(false)
  }

  /** 导航失败（ERR_ABORTED 之类）由页面自己显示，这里只防未处理的 Promise。 */
  load(tab, url) {
    // loaded 记的是「这个标签代表哪个实例地址」（空串 = 实例停了、显示停止页），
    // 不是视图里实际加载的地址——停止页、data: 页都不该被当成实例地址去比对。
    tab.loaded = url
    tab.view.webContents.loadURL(url || this.placeholder()).catch(() => {})
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
        return
      }
      case 'present':
        this.present(request.serial)
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

  /**
   * 跟上实例列表：重启换了端口 / token 就换地址，停了就换成停止页。
   * 未托管的标签先按地址认领到实例（启动后第一次轮询到位时），之后标题、重启跟随才生效。
   */
  follow(instances) {
    for (const tab of this.tabs) {
      let target = tab.target
      if (target.managed === false) {
        const adopted = adoptTarget(tab.loaded || target.url, instances)
        if (adopted) {
          if (this.selected === target.id) this.selected = adopted.id
          target = { ...adopted, title: adopted.title || target.title }
        }
      }
      const next = followTarget(target, instances)
      if (tab.loaded !== next.url) {
        this.load(tab, next.url)
        tab.pageTitle = ''
      }
      tab.target = next.target
    }
    this.render(false)
  }

  /**
   * 页面进程崩溃后重新装回这个标签：重新导航到带启动 token 的地址，而不是 reload。
   * token 在这个 dsh 进程的生命周期内一直有效，服务端会重发 cookie 并 303 到主页，
   * 和从启动器「打开」走的是同一条认证路径（原因见旧外壳 tabs.rs 的 recover：WKWebView 崩溃后
   * reload 不带 SameSite=Strict 的认证 cookie；Chromium 下这条路同样稳妥）。
   */
  recoverByView(view) {
    const tab = this.tabs.find((item) => item.view === view)
    // 实例已停止时 loaded 为空，标签上那张停止提示页由下一次 follow 重画，这里不抢。
    if (!tab?.loaded) return
    this.load(tab, tab.loaded)
  }

  titleByView(view, title) {
    const tab = this.tabs.find((item) => item.view === view)
    if (!tab) return
    tab.pageTitle = normalizePageTitle(title)
    this.render(false)
  }

  /** 标签页里点出来的新窗口链接：同一个 dsh 就在本标签里开，其余交给外壳分派。 */
  linkByView(view, url) {
    const tab = this.tabs.find((item) => item.view === view)
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
      dark: this.dark,
      presentation: this.presentation,
      request: this.selectionRequest,
      orderRequest: this.orderRequest,
      tabs: this.tabs.map((tab) => ({
        id: tab.target.id,
        title: tab.target.title || 'DSH',
        pageTitle: tab.pageTitle,
        stopped: !tab.loaded,
      })),
    })
    // 第一页没有「旧页面」可以闪：直接显示出来，不等标签条页的回执（它还在加载时也能先看到内容）。
    if (!this.tabs.some((tab) => tab.visible)) {
      const first = this.tabs.find((tab) => tab.target.id === this.selected)
      if (first) {
        first.view.setVisible(true)
        first.visible = true
        first.view.webContents.focus()
      }
    }
    if (!force && value === this.rendered) {
      this.syncTitle()
      return
    }
    this.rendered = value
    this.strip.executeJavaScript(`window.updateTabStrip?.(${value})`).catch(() => {})
    this.syncTitle()
  }

  /** 窗口标题跟着选中的标签走：任务栏 / 窗口切换器里能看出这是哪个 dsh。 */
  syncTitle() {
    if (this.window.isDestroyed?.()) return
    const tab = this.tabs.find((item) => item.target.id === this.selected)
    this.window.setTitle([tab?.target.title, tab?.pageTitle].filter(Boolean).join(' — ') || 'DSH')
  }
}
