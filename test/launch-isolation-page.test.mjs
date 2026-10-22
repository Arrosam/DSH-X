/**
 * 「添加启动项」的隔离方式引导：三档 tab 切换——Profile 隔离（默认）/ 完全隔离两档一键新建，
 * 自定义档露出原来的完整表单。页面是无构建的原生 JS，这里读 HTML/CSS 源码做结构断言（和
 * launch-home-page、update-channel-page 一个路子），交互函数抠出来放进 vm 里跑，不起服务。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const page = read('index.html')
const css = read('launcher.css')

function section(from, to) {
  const start = page.indexOf(from)
  assert.ok(start >= 0, `页面里找不到「${from}」`)
  const end = page.indexOf(to, start + from.length)
  assert.ok(end > start, `「${from}」后面找不到「${to}」`)
  return page.slice(start, end)
}

/** 抠一个具名函数的源码（数花括号配平），给 vm 单独跑；sync / async 都认。 */
function functionSource(name) {
  const start = [`    function ${name}(`, `    async function ${name}(`]
    .map((mark) => page.indexOf(mark)).find((index) => index >= 0)
  assert.ok(start >= 0, `页面里找不到函数 ${name}()`)
  let depth = 0
  for (let i = page.indexOf('{', start); i < page.length; i += 1) {
    if (page[i] === '{') depth += 1
    else if (page[i] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, i + 1)
    }
  }
  throw new Error(`函数 ${name}() 的花括号没有配平`)
}

/** 两个路径比较的小工具（页面里就是这两行 const）。 */
const pathHelpers = page.slice(page.indexOf('    const normalizeHomePath ='), page.indexOf('    /** 完全隔离的默认目录'))

const EN_REQUIRED = [
  '隔离方式', 'Profile 隔离', '完全隔离', '自定义',
  '将自动新建 Profile「{name}」：沿用全局 dsh 目录，会话与记忆共享，插件与配置独立。',
  '将自动新建独立目录 {path}，用 Profile web 启动：会话、记忆、插件与配置全部独立。',
  '数据目录还没就绪，稍后再试',
  '版本、端口、目录和 Profile 都在这里手动选；要新目录先去「管理目录」里添加。',
  '编辑 Profile…',
  'Profile「{profile}」还没初始化：先用它启动一次，dsh 会建好这个环境，之后就能在这里编辑。',
]

test('三档 tab：默认 Profile 隔离，顺序固定，tab 带无障碍角色和选中态', () => {
  const dialog = section('id="launchDialog"', '</form>')
  assert.match(dialog, /<div class="launch-isolation" id="launchIsolationField">/)
  assert.match(dialog, /class="launch-isolation-tabs" role="tablist" aria-label="隔离方式"/)
  const tabs = [...dialog.matchAll(/<button class="launch-isolation-tab"[^>]*data-isolation="(profile|home|custom)"[^>]*>/g)]
  assert.deepEqual(tabs.map((match) => match[1]), ['profile', 'home', 'custom'], 'tab 顺序：Profile 隔离 → 完全隔离 → 自定义')
  assert.equal((dialog.match(/role="tab"/g) || []).length, 3, '三个 tab 都要 role=tab')
  assert.equal((dialog.match(/aria-selected="true"/g) || []).length, 1, '只允许一个当前档')
  assert.match(dialog, /data-isolation="profile" aria-selected="true"/, '默认选中 Profile 隔离')
  for (const label of ['Profile 隔离', '完全隔离', '自定义']) {
    assert.ok(dialog.includes(`data-i18n="${label}">${label}</button>`), `tab 文案要有中英翻译：${label}`)
  }
  // 说明行是 JS 按当前档动态写的，不能写死在标签里（切档/切语言都要跟着变）
  assert.match(dialog, /<p class="hint" id="launchIsolationHint"><\/p>/)
  // 前两档什么都不用填：不再有目录输入或 Profile 名字输入
  assert.ok(!page.includes('launchHomePath'), '旧的「新用户目录」输入已经删掉')
  assert.ok(!page.includes('launchProfileName'), '旧的「新 Profile 名称」输入已经删掉')
  assert.ok(!page.includes('launchPickHome'), '旧的「选择目录…」按钮已经删掉')
  assert.ok(!page.includes('launchIsolationOption'), '旧的单选卡片已经换成 tab')
  assert.ok(!page.includes('launch-isolation-option'), '旧的单选卡片样式已经换成 tab')
})

test('自定义档是可显隐的字段块：原来那张完整表单原样搬进来，id 一个没改', () => {
  const fields = section('<div class="launch-custom-fields" id="launchCustomFields">', '<label class="toggle launch-auto-launch">')
  assert.match(fields, /id="versionPicker"[\s\S]*id="launchUpdateChannel"/, '版本行也在里面')
  assert.match(fields, /id="launchIdentityField"[\s\S]*id="launchName"/)
  assert.match(fields, /id="launchHomeSelectField"[\s\S]*<label for="launchDshHome"[\s\S]*<select id="launchDshHome"[^>]*><\/select>/)
  assert.match(fields, /id="launchProfileSelectField"[\s\S]*<select id="launchProfile" title="Profile"><\/select>/)
  assert.match(fields, /id="launchPort"/)
  // 字段块夹在 tab 和自动启动开关之间；前两档页面上只剩三档 tab、说明和开关
  const fieldAt = page.indexOf('id="launchCustomFields"')
  assert.ok(page.indexOf('id="launchIsolationField"') < fieldAt, 'tab 在前，字段块在后')
  assert.ok(fieldAt < page.indexOf('id="launchAutoLaunch"'), '字段块在自动启动开关前面')
})

test('切档时字段块靠 hidden 显隐，tab 是胶囊分段：底槽 + 当前档浮起', () => {
  assert.match(css, /\.launch-isolation\[hidden\] \{ display: none; \}/)
  assert.match(css, /\.launch-custom-fields\[hidden\] \{ display: none; \}/)
  // 胶囊分段：底槽浅色圆角，当前档卡片色浮起（跟技能来源切换同一套语言）
  assert.match(css, /\.launch-isolation-tabs \{ display: flex; gap: 2px; padding: 4px; border-radius: 12px; background: var\(--accent-soft\); \}/)
  assert.match(css, /\.launch-isolation-tab \{ flex: 1 1 0; padding: 8px; border: 0; border-radius: 9px; background: transparent/)
  assert.match(css, /\.launch-isolation-tab\[aria-selected="true"\] \{ background: var\(--card\); color: var\(--accent\); font-weight: 600; box-shadow:/, '当前档胶囊浮起')
  assert.match(css, /\.launch-isolation-tab:focus-visible \{ outline:/, '键盘焦点描边')
  assert.ok(!css.includes('.launch-isolation-tab::after'), '下划线指示条已经换掉')
  assert.ok(!css.includes('.launch-home-path'), '旧的目录输入样式已经删掉')
  assert.ok(!css.includes('.launch-isolation-option'), '旧的单选卡片样式换成了 tab')
})

test('英文界面有全部引导文案（t() 的字典里逐条存在，不能漏翻）', () => {
  const dict = section('const EN = {', 'function t(zh, vars)')
  for (const zh of EN_REQUIRED) assert.ok(dict.includes(`${JSON.stringify(zh)}: `), `缺少英文翻译：${zh}`)
})

/** setLaunchIsolation 的 vm 环境：字段桩 + 代填函数桩，只关心"切档后谁藏谁露、名字怎么代填"。 */
function isolationHarness() {
  const calls = { paint: 0, autoNames: 0 }
  const context = vm.createContext({
    paintLaunchIsolation: () => { calls.paint += 1 },
    guidedLaunchName: () => { calls.autoNames += 1; return 'auto-name' },
    launchIsolationFieldEl: { hidden: false },
    launchCustomFieldsEl: { hidden: false },
    launchNameEl: { value: '', required: true },
    launchNameAuto: '',
  })
  vm.runInContext(functionSource('setLaunchIsolation'), context)
  return { context, calls }
}

test('切档只改可见性：前两档收起字段块、名字代填，自定义档把原表单还回来', () => {
  const { context, calls } = isolationHarness()

  context.setLaunchIsolation('profile', true)
  assert.equal(context.launchIsolationFieldEl.hidden, false, '新建时 tab 要露出来')
  assert.equal(context.launchCustomFieldsEl.hidden, true, 'Profile 隔离什么都不用填')
  assert.equal(context.launchNameEl.value, 'auto-name', '名字代填好，用户不用填')
  assert.equal(context.launchNameEl.required, false, '藏起来的名称输入不能拦着提交')
  assert.ok(calls.paint > 0, '切档后要重画选中态和说明')

  context.launchNameEl.value = ''
  context.setLaunchIsolation('home', true)
  assert.equal(context.launchCustomFieldsEl.hidden, true, '完全隔离同样什么都不用填')
  assert.equal(context.launchNameEl.value, 'auto-name')

  context.setLaunchIsolation('custom', true)
  assert.equal(context.launchCustomFieldsEl.hidden, false, '自定义档把完整表单还回来')
  assert.equal(context.launchNameEl.required, true, '自定义档名称仍然是必填')
})

test('编辑已有启动项不显示隔离 tab，字段块直接露出来', () => {
  const { context, calls } = isolationHarness()
  context.launchNameEl.value = '我的工作环境'
  context.setLaunchIsolation('custom', false)
  assert.equal(context.launchIsolationFieldEl.hidden, true, '编辑老启动项时引导整块收起')
  assert.equal(context.launchCustomFieldsEl.hidden, false, '手填字段不能藏起来')
  assert.equal(context.launchNameEl.value, '我的工作环境', '编辑时不代填名字')
  assert.equal(context.launchNameEl.required, true)
  assert.equal(calls.autoNames, 0, '编辑不调用代填')
})

/** prepareGuidedLaunch 的 vm 环境：真实建议值函数 + 接口收集桩，验证它算出什么、发了哪些请求。 */
function guidedHarness({ mode, dataDir = 'C:\\data', dshHomes = [], profiles = ['web'], home } = {}) {
  const calls = { gets: [], posts: [] }
  const context = vm.createContext({
    t: (text) => text,
    state: { dataDir, dshHomes, profiles },
    launchEntries: () => [],
    launchProfile: 'web',
    getJson: async (url) => {
      calls.gets.push(url)
      const requested = url.includes('home=') ? decodeURIComponent(url.slice(url.indexOf('home=') + 5)) : ''
      return { home: home ?? (requested || 'C:\\global'), profiles, webProfiles: ['web'] }
    },
    post: async (url, body) => { calls.posts.push([url, body]); return { ok: true } },
  })
  context.launchIsolation = mode
  vm.runInContext(
    `${pathHelpers}\n${functionSource('suggestIsolatedHome')}\n${functionSource('suggestIsolatedProfile')}\n${functionSource('prepareGuidedLaunch')}`,
    context,
  )
  return { context, calls }
}

test('Profile 隔离：名字和 Profile 全代算，不存在的 Profile 交给保存接口补建', async () => {
  const h = guidedHarness({ mode: 'profile', profiles: ['web'] })
  const target = await h.context.prepareGuidedLaunch()
  assert.deepEqual({ name: target.name, profile: target.profile, dshHome: target.dshHome }, { name: 'work', profile: 'work', dshHome: '' })
  assert.equal(h.context.launchProfile, 'work', '保存时用的 profile 变量也要跟着改')
  assert.deepEqual(h.calls.posts, [], '不先建 Profile：一次保存请求里由服务端 ensureProfile 完成')
  assert.deepEqual(h.calls.gets, [], '连目录探测都不用，全是代算的')

  // 工作名被占了就往后挑一个，不会跟现有 Profile 撞车
  const busy = guidedHarness({ mode: 'profile', profiles: ['web', 'work', 'home'] })
  const next = await busy.context.prepareGuidedLaunch()
  assert.equal(next.profile, 'work2')
  assert.equal(next.name, 'work2')
})

test('完全隔离：目录代算在数据目录 homes 下、自动登记，重名往后顺延', async () => {
  const fresh = guidedHarness({ mode: 'home', dshHomes: [] })
  const target = await fresh.context.prepareGuidedLaunch()
  assert.equal(target.dshHome, 'C:\\data\\homes\\dsh', '默认开在数据目录的 homes 下')
  assert.equal(target.profile, 'web', '新目录用模板 profile 直接能起网页')
  assert.equal(target.name, 'dsh', '启动项名字取目录最后一段')
  assert.equal(fresh.calls.gets.length, 1, '先探一次目录里有哪些 Profile')
  assert.deepEqual(fresh.calls.posts.map(([url]) => url), ['/api/dsh-homes/add'], '新目录顺手登记到管理目录')
  assert.equal(fresh.calls.posts[0][1].home, 'C:\\data\\homes\\dsh')

  const known = guidedHarness({ mode: 'home', dshHomes: ['C:/data/homes/dsh'] })
  const second = await known.context.prepareGuidedLaunch()
  assert.equal(second.dshHome, 'C:\\data\\homes\\dsh-2', '已登记的目录不重复用，序号顺延')
  assert.equal(second.name, 'dsh-2')

  const noData = guidedHarness({ mode: 'home', dataDir: '' })
  await assert.rejects(noData.context.prepareGuidedLaunch(), /数据目录还没就绪/)
})

test('保存与打开弹窗的接线：新建走引导时名字也代填，带 ensureProfile；编辑/自定义仍用原来的下拉值', () => {
  const submit = section('    launchFormEl.onsubmit = async', '    launchDeleteEl.onclick = async')
  assert.match(submit, /const guided = !editingLaunchId && launchIsolation !== 'custom'/)
  assert.match(submit, /prepareGuidedLaunch\(\)/)
  assert.match(submit, /name: guided \? target\.name : launchNameEl\.value/)
  assert.match(submit, /\.\.\.\(guided \? \{ ensureProfile: true \} : \{\}\)/)
  assert.match(submit, /guided \? target\.profile : launchProfile/)
  assert.match(submit, /guided \? target\.dshHome : launchDshHomeEl\.value\.trim\(\)/)
  // 引导模式不再刷新下拉（新目录/新 Profile 由服务端处理），编辑和自定义才刷新
  assert.match(submit, /if \(!guided && !await refreshLaunchHomeProfiles\(true\)\) return/)

  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /setLaunchIsolation\(entry \? 'custom' : launchIsolationSaved, !entry\)/, '新建用上次保存的档，编辑直接落自定义档')
})

test('记住上次选的档：打开「添加启动项」落在保存过的档，切档时顺手存回设置', () => {
  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /setLaunchIsolation\(entry \? 'custom' : launchIsolationSaved, !entry\)/, '新建从上次那一档开始')
  const click = section('    launchIsolationFieldEl.onclick =', '    async function prepareGuidedLaunch(')
  assert.match(click, /if \(editingLaunchId\) return/, '编辑老启动项时不写偏好')
  assert.match(click, /launchIsolationSaved = launchIsolation/, '本地也立刻记住，不等写盘回来')
  assert.match(click, /queueSetting\('launchIsolation', launchIsolation\)/, '切档后记住这一档')
  // 写盘回来以服务端归一化后的值为准
  const flush = section('    async function flushSettings() {', '    function queueSetting(key, value) {')
  assert.match(flush, /if \(!\('launchIsolation' in data\)\) throw new Error/)
  assert.match(flush, /launchIsolationSaved = data\.launchIsolation === 'home' \|\| data\.launchIsolation === 'custom' \? data\.launchIsolation : 'profile'/)
  // 设置加载时回填：服务端只回三档，脏值当 Profile 隔离
  const fill = section('    function fillSettings(data) {', '    function loadSettings()')
  assert.match(fill, /'launchIsolation' in data/)
  assert.match(fill, /launchIsolationSaved = data\.launchIsolation === 'home' \|\| data\.launchIsolation === 'custom' \? data\.launchIsolation : 'profile'/)
})

test('动效接线：胶囊浮起有过渡、字段淡入、说明行淡入，都尊重「减少动态」', () => {
  assert.match(css, /\.launch-isolation-tab \{[^}]*transition: color 160ms ease, background-color 160ms ease, box-shadow 160ms ease/, '胶囊浮起得有过渡')
  assert.match(css, /\.launch-custom-fields:not\(\[hidden\]\) \{ animation: launch-custom-in/, '切到自定义时字段淡入')
  assert.match(css, /#launchIsolationHint\.isolation-hint-in \{ animation: launch-isolation-hint-in/, '换档时说明行淡入')
  assert.match(css, /html\.reduce-motion #launchIsolationHint\.isolation-hint-in \{ animation: none; \}/, '减少动态时不做动画')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, '系统级减少动态也要跟着关掉')
  const paint = section('    function paintLaunchIsolation() {', '    launchIsolationFieldEl.onclick =')
  assert.match(paint, /tab\.setAttribute\('aria-selected'/, '当前档靠 aria-selected，样式跟着它走')
  assert.match(paint, /if \(launchIsolationHintEl\.textContent === hint\) return/, '文字相同就不重播动画')
  assert.match(paint, /classList\.remove\('isolation-hint-in'\)\n\s+void launchIsolationHintEl\.offsetWidth\n\s+launchIsolationHintEl\.classList\.add\('isolation-hint-in'\)/, '重播动画前先复位，避免连点不触发')
  // tab 点击 = 切档：只认带 data-isolation 的按钮，避免点到容器也触发
  assert.match(page, /event\.target\.closest\?\.\('\.launch-isolation-tab'\)/)
  assert.match(page, /setLaunchIsolation\(tab\.dataset\.isolation\)/)
})
