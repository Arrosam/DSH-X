/**
 * 标签窗口宿主的纯逻辑与状态机：启动参数 → 动作（host.mjs）、标签跟随实例（标题同步）、
 * 以及 BrowserTabs 在假视图上的行为（不用装 Electron 也能跑）。
 *
 * 启动契约是原生外壳和 shell/main.mjs 之间的约定，改这里之前先看 docs/no-electron-runtime.md
 * 的「Electron 标签窗口」一节。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { adoptTarget, followTarget, parseLaunchArgs, parseLaunchRequest, routeLaunch } from '../shell/host.mjs'
import { BrowserTabs } from '../shell/tabs.mjs'

const TAB_URL = 'http://127.0.0.1:4567/?token=abc'
const WINDOW_URL = 'http://127.0.0.1:4567/other?token=def'

test('启动参数：--tab / --window / --show 三组，其余参数一律跳过', () => {
  assert.deepEqual(
    parseLaunchArgs(['/electron/Electron', '/app', '--tab', TAB_URL, '--title', 'web · 1']).request,
    { show: false, tab: { url: TAB_URL, title: 'web · 1' }, window: null },
  )
  assert.deepEqual(parseLaunchArgs(['--window', WINDOW_URL]).request, { show: false, tab: null, window: { url: WINDOW_URL } })
  assert.deepEqual(parseLaunchArgs(['--show']).request, { show: true, tab: null, window: null })
  // Electron / Chromium 自己的开关与位置参数不归我们管
  const noisy = parseLaunchArgs(['--no-sandbox', '--enable-features=Foo', '/electron', '--tab', TAB_URL, '--allow-file-access-from-files'])
  assert.equal(noisy.error, '')
  assert.equal(noisy.request.tab.url, TAB_URL)
  // 标题可选；空串当作没给
  assert.equal(parseLaunchArgs(['--tab', TAB_URL, '--title', '']).request.tab.title, '')
  // 两种启动方式可以同时给（原生外壳不会这么干，但别因此丢参数）
  const both = parseLaunchArgs(['--tab', TAB_URL, '--window', WINDOW_URL])
  assert.equal(both.request.tab.url, TAB_URL)
  assert.equal(both.request.window.url, WINDOW_URL)
})

test('启动参数：少值、外部地址、修饰不上标签的标题都算错误', () => {
  const cases = [
    [],
    ['--tab'],
    ['--tab', '--show'],
    ['--tab', 'https://example.com/'],
    ['--tab', 'javascript:alert(1)'],
    ['--window', 'file:///etc/passwd'],
    ['--title', 'web · 1'],
    ['--tab', TAB_URL, '--title'],
  ]
  for (const argv of cases) {
    const result = parseLaunchArgs(argv)
    assert.equal(result.request, null, argv.join(' '))
    assert.ok(result.error, argv.join(' '))
  }
})

test('第二实例的参数交接：请求对象走 additionalData，校验规则与命令行一致', () => {
  // 第二实例把自己解析出来的 request 原样递过来（JSON 往返一次，模拟进程间传递）
  const parsed = parseLaunchArgs(['--tab', TAB_URL, '--title', 'web · 1']).request
  assert.deepEqual(parseLaunchRequest(JSON.parse(JSON.stringify(parsed))).request, parsed)
  assert.deepEqual(parseLaunchRequest({ show: true }).request, { show: true, tab: null, window: null })
  assert.equal(parseLaunchRequest({ tab: { url: 'https://example.com/' } }).request, null)
  assert.equal(parseLaunchRequest({ window: { url: 'file:///etc/passwd' } }).request, null)
  assert.equal(parseLaunchRequest({}).request, null)
  assert.equal(parseLaunchRequest(null).request, null)
  // 标题缺省 / 非字符串都按没标题处理，不因为脏字段丢掉整个请求
  assert.equal(parseLaunchRequest({ tab: { url: TAB_URL, title: 7 } }).request.tab.title, '')
})

test('第二实例路由：同一实例只切标签，不重复开页', () => {
  const state = { tabWindow: true, tabs: [{ id: 'web', url: TAB_URL }], window: false }
  const select = routeLaunch({ show: false, tab: { url: 'http://127.0.0.1:4567/?token=rotated', title: '' }, window: null }, state)
  assert.equal(select.selectTab, 'web')
  assert.equal(select.openTab, null)
  assert.equal(select.show, true)

  const open = routeLaunch({ show: false, tab: { url: 'http://127.0.0.1:9999/?token=x', title: '新实例' }, window: null }, state)
  assert.deepEqual(open.openTab, { url: 'http://127.0.0.1:9999/?token=x', title: '新实例' })
  assert.equal(open.selectTab, '')
  assert.equal(open.show, true)
})

test('第二实例路由：独立窗口只有一扇，--show 没有窗口时什么都不做', () => {
  const alone = routeLaunch({ show: true, tab: null, window: null }, { tabWindow: true, tabs: [], window: false })
  assert.equal(alone.show, true)
  assert.equal(routeLaunch({ show: true, tab: null, window: null }, { tabWindow: false, tabs: [], window: false }).show, false)

  const reuse = routeLaunch({ show: false, tab: null, window: { url: WINDOW_URL } }, { tabWindow: false, tabs: [], window: true })
  assert.equal(reuse.followWindow, true)
  assert.equal(reuse.openWindow, null)
  assert.equal(reuse.show, true)
  const create = routeLaunch({ show: false, tab: null, window: { url: WINDOW_URL } }, { tabWindow: false, tabs: [], window: false })
  assert.deepEqual(create.openWindow, { url: WINDOW_URL })
  assert.equal(create.followWindow, false)
})

test('标签跟随实例：标题从轮询结果同步，停了换停止页地址', () => {
  const instance = { id: 'inst', title: 'web · 1.0.0', url: TAB_URL, status: 'running', managed: true }
  // 启动时的临时标题（--title 或 DSH）在第一次轮询后换成实例的真实标题
  const renamed = followTarget({ ...instance, title: '旧标题' }, [instance])
  assert.equal(renamed.target.title, 'web · 1.0.0')
  assert.equal(renamed.url, TAB_URL)
  // 启动项改名、dsh 重启换端口（同一 id）都要跟上
  const moved = followTarget(instance, [{ ...instance, title: '改名后', url: 'http://127.0.0.1:8888/?token=new' }])
  assert.equal(moved.target.title, '改名后')
  assert.equal(moved.url, 'http://127.0.0.1:8888/?token=new')
  // 停了 / 从列表里消失：地址置空（显示停止页），标题保留
  for (const instances of [[{ ...instance, status: 'stopped' }], []]) {
    const stopped = followTarget(instance, instances)
    assert.equal(stopped.url, '')
    assert.equal(stopped.target.status, 'stopped')
    assert.equal(stopped.target.title, 'web · 1.0.0')
  }
  // 未托管的标签不能因为「查不到 id」被当成停了
  const unmanaged = followTarget({ id: TAB_URL, title: 'DSH', url: TAB_URL, status: 'running', managed: false }, [])
  assert.equal(unmanaged.url, TAB_URL)
})

test('按地址认领实例：端口 + token 的 origin 就是这个实例', () => {
  const instance = { id: 'inst', title: 'web', url: TAB_URL, status: 'running', managed: true }
  assert.equal(adoptTarget(TAB_URL, [instance]), instance)
  assert.equal(adoptTarget('http://127.0.0.1:4567/?token=other', [instance]), instance)
  assert.equal(adoptTarget('http://127.0.0.1:4568/?token=other', [instance]), null)
  assert.equal(adoptTarget('', [instance]), null)
  assert.equal(adoptTarget('https://example.com/', [instance]), null)
})

/** 假窗口：只提供 BrowserTabs 用到的那几个成员，状态留在 _state 里给断言看。 */
function fakeWindow() {
  const state = { renders: [], title: '', bounds: { width: 1000, height: 800 }, children: [], stripFocused: 0 }
  const window = {
    webContents: {
      executeJavaScript(code) {
        state.renders.push(code)
        return Promise.resolve()
      },
      focus() { state.stripFocused += 1 },
    },
    contentView: {
      addChildView(view) { state.children.push(view) },
      removeChildView(view) { state.children = state.children.filter((item) => item !== view) },
    },
    getContentBounds: () => state.bounds,
    setTitle(title) { state.title = title },
    isDestroyed: () => false,
    _state: state,
  }
  return window
}

function fakeView() {
  const view = {
    visible: false,
    bounds: null,
    loads: [],
    reloads: 0,
    closed: false,
    setVisible(value) { view.visible = value },
    setBounds(bounds) { view.bounds = bounds },
    webContents: {
      loadURL(url) { view.loads.push(url); return Promise.resolve() },
      reload() { view.reloads += 1 },
      focus() {},
      close() { view.closed = true },
    },
  }
  return view
}

/** 主进程推给标签条页的那串 executeJavaScript 参数就是完整状态：取出来当断言依据。 */
function stripState(window) {
  const code = window._state.renders.at(-1)
  assert.ok(code, '没有向标签条页推过状态')
  const start = code.indexOf('(')
  assert.ok(start > 0, code)
  return JSON.parse(code.slice(start + 1, -1))
}

function fakeTabs({ systemDark = () => false } = {}) {
  const window = fakeWindow()
  const views = []
  const tabs = new BrowserTabs(window, {
    createView: () => {
      const view = fakeView()
      views.push(view)
      return view
    },
    systemDark,
    stripHeight: 44,
  })
  return { window, views, tabs }
}

const TARGET = { id: 'web', title: 'web · 1.0.0', url: TAB_URL, status: 'running', managed: true }

test('标签窗口：打开第一页直接显示（不等回执），尺寸从标签条下面开始', () => {
  const { window, views, tabs } = fakeTabs()
  tabs.open(TARGET)
  assert.equal(views.length, 1)
  assert.deepEqual(views[0].bounds, { x: 0, y: 44, width: 1000, height: 756 })
  assert.equal(views[0].loads.at(-1), TAB_URL)
  assert.equal(views[0].visible, true, '第一页没有旧页面可闪，不该等标签条回执')
  const state = stripState(window)
  assert.equal(state.active, 'web')
  assert.equal(state.tabs[0].title, 'web · 1.0.0')
  assert.equal(state.tabs[0].stopped, false)
  assert.equal(window._state.title, 'web · 1.0.0')

  // 窗口缩放：内容层跟着重排
  window._state.bounds = { width: 800, height: 600 }
  tabs.layout()
  assert.deepEqual(views[0].bounds, { x: 0, y: 44, width: 800, height: 556 })
})

test('标签窗口：标题跟随实例与页面标题，窗口标题一起同步', () => {
  const { window, views, tabs } = fakeTabs()
  tabs.open(TARGET)
  // 页面自己的标题（dsh 的 SPA 会一直改）只做标签提示与窗口标题；标签主标题还是实例名
  tabs.titleByView(views[0], '新会话\u0000标题')
  assert.equal(stripState(window).tabs[0].pageTitle, '新会话标题')
  assert.equal(window._state.title, 'web · 1.0.0 — 新会话标题')

  // 启动项改名 / dsh 重启后端口变化：轮询把目标换掉，标题与地址一起更新
  tabs.follow([{ ...TARGET, title: '改名后', url: 'http://127.0.0.1:8888/?token=new' }])
  assert.equal(stripState(window).tabs[0].title, '改名后')
  assert.equal(views[0].loads.at(-1), 'http://127.0.0.1:8888/?token=new')
  assert.equal(stripState(window).tabs[0].pageTitle, '', '换地址后旧的页面标题不能留在标签上')

  // 实例停了：标签标记 stopped，换成本地停止页；再起来又换回实例地址
  tabs.follow([{ ...TARGET, status: 'stopped' }])
  assert.equal(stripState(window).tabs[0].stopped, true)
  assert.ok(views[0].loads.at(-1).startsWith('data:text/html'), '停止时该显示停止页')
  tabs.follow([{ ...TARGET, url: 'http://127.0.0.1:9999/?token=back' }])
  assert.equal(stripState(window).tabs[0].stopped, false)
  assert.equal(views[0].loads.at(-1), 'http://127.0.0.1:9999/?token=back')
})

test('标签窗口：停止页跟着语言与主题重画（#58）', () => {
  let systemDark = false
  const { window, views, tabs } = fakeTabs({ systemDark: () => systemDark })
  tabs.preferences('zh', 'system')
  tabs.open(TARGET)
  tabs.follow([{ ...TARGET, status: 'stopped' }])
  const light = views[0].loads.at(-1)
  assert.ok(light.includes('f5f8ff'), '浅色停止页')

  // 系统切到深色：停止页要重画（运行中的页面不在这里重载）
  systemDark = true
  tabs.systemThemeChanged()
  assert.equal(stripState(window).dark, true)
  const dark = views[0].loads.at(-1)
  assert.notEqual(dark, light)
  assert.ok(dark.includes('15171c'), '深色停止页')

  // 语言切到英文：重画
  tabs.preferences('en', 'system')
  assert.ok(views[0].loads.at(-1).includes(encodeURIComponent('This DSH instance has stopped.')))
  assert.equal(stripState(window).lang, 'en')
})

test('启动信号早于轮询：未托管的标签按地址认领到实例，id / 标题 / 选中态一起换', () => {
  const { window, views, tabs } = fakeTabs()
  tabs.preferences('en', 'dark')
  tabs.open({ id: TAB_URL, title: 'DSH', url: TAB_URL, status: 'running', managed: false })
  assert.equal(stripState(window).tabs[0].title, 'DSH')

  const instance = { id: '["","1.0.0","web"]', title: 'web · 1.0.0', url: TAB_URL, status: 'running', managed: true }
  tabs.follow([instance])
  const state = stripState(window)
  assert.equal(state.tabs.length, 1, '不能被当成新标签再开一个')
  assert.equal(state.tabs[0].id, instance.id)
  assert.equal(state.tabs[0].title, 'web · 1.0.0')
  assert.equal(state.active, instance.id)
  assert.equal(views.length, 1)
  assert.equal(state.lang, 'en')
  assert.equal(state.dark, true)
})

test('标签窗口：点标签切页、关标签先留旧画面，回执后释放原生视图', () => {
  const { window, views, tabs } = fakeTabs()
  const other = { ...TARGET, id: 'other', title: 'other', url: 'http://127.0.0.1:7777/?token=o' }
  tabs.open(TARGET)
  tabs.open(other)
  assert.equal(stripState(window).active, 'other')
  assert.equal(views[0].visible, true, '选中态画完前旧画面不能先藏起来')
  assert.equal(views[1].visible, false, '切页要等标签条画完选中态再显示（回执 present）')
  tabs.present(stripState(window).presentation)
  assert.equal(views[1].visible, true)
  assert.equal(views[0].visible, false)

  // 快速切换：旧回执不能把页面切回去
  const serial = stripState(window).presentation
  tabs.action({ action: 'select', id: 'web', request: 7 })
  assert.equal(stripState(window).request, 7)
  assert.ok(stripState(window).presentation > serial)
  assert.equal(views[1].visible, true, '回执前还是旧页面')
  tabs.present(serial)
  assert.equal(views[1].visible, true, '旧回执不能把页面切回去')
  const latest = stripState(window).presentation
  tabs.present(latest)
  assert.equal(views[0].visible, true)
  assert.equal(views[1].visible, false)

  // 关当前标签：旧画面留到回执，替代页显示后再释放原生视图
  const beforeClose = stripState(window).presentation
  tabs.action({ action: 'close-active' })
  assert.ok(stripState(window).presentation > beforeClose)
  assert.equal(views[0].closed, false, '回执前不能释放原生视图')
  assert.equal(views[0].visible, true, '替代页显示前旧画面还在')
  tabs.present(stripState(window).presentation)
  assert.equal(views[0].closed, true)
  assert.equal(views[1].visible, true)
  assert.equal(window._state.children.length, 1)
})

test('标签窗口：打开已停止的实例显示停止页，不去连旧端口', () => {
  const { window, views, tabs } = fakeTabs()
  tabs.open({ ...TARGET, status: 'stopped' })
  assert.equal(views.length, 1)
  assert.ok(views[0].loads.at(-1).startsWith('data:text/html'), '停止的实例不该去连旧端口')
  assert.equal(stripState(window).tabs[0].stopped, true)
})

test('标签窗口：拖动排序按标签条给的顺序重排，旧请求号忽略', () => {
  const { window, tabs } = fakeTabs()
  const other = { ...TARGET, id: 'other', title: 'other', url: 'http://127.0.0.1:7777/?token=o' }
  tabs.open(TARGET)
  tabs.open(other)
  tabs.action({ action: 'reorder', ids: ['other', 'web'], request: 5 })
  assert.deepEqual(stripState(window).tabs.map((tab) => tab.id), ['other', 'web'])
  assert.equal(stripState(window).orderRequest, 5)
  // 迟到的旧排序请求不能把顺序再翻回去
  tabs.action({ action: 'reorder', ids: ['web', 'other'], request: 4 })
  assert.deepEqual(stripState(window).tabs.map((tab) => tab.id), ['other', 'web'])
})

test('标签窗口：路由与标签状态对得上（第二实例的同一实例只切过去）', () => {
  const { tabs } = fakeTabs()
  tabs.open(TARGET)
  const actions = routeLaunch(
    { show: false, tab: { url: 'http://127.0.0.1:4567/?token=again', title: '' }, window: null },
    { tabWindow: true, tabs: tabs.snapshot(), window: false },
  )
  assert.equal(actions.selectTab, 'web')
  assert.deepEqual(tabs.snapshot(), [{ id: 'web', url: TAB_URL }])
})
