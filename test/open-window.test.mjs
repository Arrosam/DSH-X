import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { appWindowArgs, chromiumCandidates, findChromiumBrowser, instanceTarget, openRoute } from '../server.js'
import { DEFAULTS, OPEN_MODES, safeOpenMode } from '../settings.js'

// 系统浏览器标签页是默认；已有明确选择不被覆盖，被删掉的形态要静默落回默认。

test('打开方式默认浏览器标签页，缺失或脏值回默认，已有选择保持不变', () => {
  assert.deepEqual(OPEN_MODES, ['tab', 'app', 'window', 'electron'])
  assert.equal(DEFAULTS.openMode, 'tab')
  assert.equal(safeOpenMode('app'), 'app')
  assert.equal(safeOpenMode('window'), 'window')
  assert.equal(safeOpenMode('electron'), 'electron')
  assert.equal(safeOpenMode('tab'), 'tab')
  assert.equal(safeOpenMode('webview'), 'tab', '没实现的形态不能被放行')
  assert.equal(safeOpenMode(''), 'tab')
  assert.equal(safeOpenMode(undefined), 'tab')
})

test('Electron 标签页：装好了才走外壳，没装就退回浏览器', () => {
  assert.equal(openRoute('electron', false, true), 'electron', '不需要原生外壳，Electron 自己就是壳')
  assert.equal(openRoute('electron', true, true), 'electron')
  assert.equal(openRoute('electron', true, false), 'browser', '没下载 Electron 时安静退回')
  assert.equal(openRoute('electron', false, false), 'browser')
})

// 内部标签页已经从框架里移除：老设置里存着 internal 的用户升级上来，不能点开什么都没反应。
test('老设置里的内部标签页静默落回浏览器标签页', () => {
  assert.equal(safeOpenMode('internal'), 'tab')
  assert.equal(openRoute('internal', true), 'browser')
  assert.equal(openRoute('internal', false), 'browser')
})

test('应用窗口的参数就是 --app=<url>', () => {
  assert.deepEqual(appWindowArgs('http://127.0.0.1:59482/?token=x'), ['--app=http://127.0.0.1:59482/?token=x'])
})

test('浏览器候选：Windows 优先用户自己的 Chrome，其次 Edge（自带，兜底最稳）', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  }
  const list = chromiumCandidates(env, 'win32')
  assert.match(list[0], /Chrome[\\/]Application[\\/]chrome\.exe$/)
  assert.ok(list.some((item) => /Edge[\\/]Application[\\/]msedge\.exe$/.test(item)), 'Edge 要在候选里')
  // 便携版 / 指定浏览器：一条 DSH_CHROMIUM 就够
  assert.deepEqual(chromiumCandidates({ DSH_CHROMIUM: 'D:\\chrome\\chrome.exe' }, 'win32'), ['D:\\chrome\\chrome.exe'])
})

test('找不到任何 Chromium 时返回空串（调用方据此退回默认浏览器）', () => {
  const empty = { LOCALAPPDATA: join(tmpdir(), 'no-such-la'), ProgramFiles: join(tmpdir(), 'no-such-pf') }
  assert.equal(findChromiumBrowser(empty, 'win32'), '')
})

test('DSH_CHROMIUM 指到真实文件就被采用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chromium-'))
  const fake = join(dir, 'chrome.exe')
  writeFileSync(fake, '')
  assert.equal(findChromiumBrowser({ DSH_CHROMIUM: fake }, 'win32'), fake)
})

test('桌面窗口模式只在原生外壳托管时成立', () => {
  assert.equal(openRoute('window', true), 'window')
  assert.equal(openRoute('window', false), 'browser', '源码运行（没有外壳）时退回系统浏览器')
  // 另外两种模式跟外壳在不在无关
  assert.equal(openRoute('app', true), 'browser')
  assert.equal(openRoute('app', false), 'browser')
  assert.equal(openRoute('tab', true), 'browser')
  assert.equal(openRoute('tab', false), 'browser')
})

test('设置页在「选了桌面窗口但没有原生外壳」时如实说明会落到标签页', () => {
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')
  assert.match(html, /openModeEl\.value === 'window' && data\.openModeWindow === false/, '按服务端给的可用性判断')
  assert.match(html, /当前预览使用浏览器标签页/, '说明会退回浏览器标签页')
  assert.match(html, /打开 dsh 的方式[\s\S]{0,400}?<select id="openMode"><\/select>/, '还是同一个下拉')
})

test('实例按环境和版本识别，重启更换端口与认证 token 仍是同一项', () => {
  const instance = { home: 'C:\\dsh-home', version: '1.0.0', profile: 'web', status: 'running', url: 'http://127.0.0.1:1234/?token=first' }
  const first = instanceTarget(instance)
  const restarted = instanceTarget({ ...instance, url: 'http://127.0.0.1:2345/?token=second' })
  assert.equal(first.id, restarted.id)
  assert.equal(restarted.url, 'http://127.0.0.1:2345/?token=second')
  assert.notEqual(first.id, instanceTarget({ ...instance, profile: 'other' }).id)
  assert.notEqual(first.id, instanceTarget({ ...instance, home: 'D:\\other-home' }).id)
  assert.notEqual(first.id, instanceTarget({ ...instance, version: '2.0.0' }).id)
  assert.ok(!first.id.includes('token=') && !first.title.includes('token='))
})

// 顶栏再没有标签区：外壳页面与样式都不该留下它的痕迹。
test('管理页不再带内部标签页的结构与样式', () => {
  const root = new URL('../public/', import.meta.url)
  for (const name of ['index.html', 'launcher.css', 'launcher-boot.css']) {
    assert.doesNotMatch(readFileSync(fileURLToPath(new URL(name, root)), 'utf8'), /internal-tab/, `${name} 还留着标签页的痕迹`)
  }
})
