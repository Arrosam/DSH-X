import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { appWindowArgs, chromiumCandidates, findChromiumBrowser, internalTabTarget, openRoute } from '../server.js'
import { DEFAULTS, DEFAULT_UPDATE_SOURCE, OPEN_MODES, safeOpenMode, updateUrlCandidates } from '../settings.js'

// 安装包里不再带 Electron：默认交给系统浏览器；内部标签页 / 独立窗口要外壳支持且运行时已下载。

test('打开方式默认系统浏览器，缺失或脏值回默认，已有选择保持不变', () => {
  assert.deepEqual(OPEN_MODES, ['tab', 'app', 'window', 'internal'])
  assert.equal(DEFAULTS.openMode, 'tab')
  assert.equal(safeOpenMode('app'), 'app')
  assert.equal(safeOpenMode('window'), 'window')
  assert.equal(safeOpenMode('internal'), 'internal')
  assert.equal(safeOpenMode('tab'), 'tab')
  assert.equal(safeOpenMode('webview'), 'tab', '没实现的形态不能被放行')
  assert.equal(safeOpenMode(''), 'tab')
  assert.equal(safeOpenMode(undefined), 'tab')
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

test('Electron 窗口/标签要「外壳能托管」且「运行时已下载」同时成立', () => {
  // 有外壳 + 运行时 → 按选择走 Electron
  assert.equal(openRoute('window', true, true), 'window')
  assert.equal(openRoute('internal', true, true), 'internal')
  // 有外壳但运行时没装：退回系统浏览器（设置页会提示下载）
  assert.equal(openRoute('window', true, false), 'browser')
  assert.equal(openRoute('internal', true, false), 'browser')
  // 源码运行 / 页面开在普通浏览器里：没有外壳，装没装运行时都不成立
  assert.equal(openRoute('window', false, true), 'browser')
  assert.equal(openRoute('internal', false, true), 'browser')
  assert.equal(openRoute('window', false, false), 'browser')
  assert.equal(openRoute('internal', false, false), 'browser')
  // 浏览器方式跟外壳与运行时都无关
  for (const shell of [true, false]) {
    for (const ready of [true, false]) {
      assert.equal(openRoute('tab', shell, ready), 'browser')
      assert.equal(openRoute('app', shell, ready), 'browser')
    }
  }
})

test('设置页在运行时没装时不假装可用：提示下载并提供入口', () => {
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')
  // 能力以服务端为准（与 openRoute 同一套判定），页面只负责降级与提示
  assert.match(html, /runtimeState\.windowReady/)
  assert.match(html, /runtimeState\.internalReady/)
  assert.match(html, /需要下载 Electron 运行时后，内部标签页和独立窗口才能使用。/)
  // 下载入口与进度走服务端的运行时接口
  assert.match(html, /id="runtimeDownload"/)
  assert.match(html, /\/api\/runtime\/download/)
  assert.match(html, /addEventListener\('runtime'/)
  assert.match(html, /打开 dsh 的方式[\s\S]{0,400}?<select id="openMode"><\/select>/, '还是同一个下拉')
})

test('中英文案成对：运行时下载相关的提示两边都有', () => {
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')
  for (const text of [
    'Electron 运行时',
    '下载运行时',
    '取消下载',
    '需要下载 Electron 运行时后，内部标签页和独立窗口才能使用。',
    '内部标签页需要 Electron 运行时；当前使用浏览器标签页。',
    '独立桌面窗口需要 Electron 运行时；当前使用浏览器标签页。',
  ]) {
    const line = html.split('\n').find((row) => row.trimStart().startsWith(`"${text}":`))
    assert.ok(line, `缺中文文案：${text}`)
    assert.match(line, /":\s*"[^"]+"/, `缺英文对照：${text}`)
  }
})

test('内部标签按环境和版本识别，重启更换端口与认证 token 不会增加标签', () => {
  const instance = { home: 'C:\\dsh-home', version: '1.0.0', profile: 'web', status: 'running', url: 'http://127.0.0.1:1234/?token=first' }
  const first = internalTabTarget(instance)
  const restarted = internalTabTarget({ ...instance, url: 'http://127.0.0.1:2345/?token=second' })
  assert.equal(first.id, restarted.id)
  assert.equal(restarted.url, 'http://127.0.0.1:2345/?token=second')
  assert.notEqual(first.id, internalTabTarget({ ...instance, profile: 'other' }).id)
  assert.notEqual(first.id, internalTabTarget({ ...instance, home: 'D:\\other-home' }).id)
  assert.notEqual(first.id, internalTabTarget({ ...instance, version: '2.0.0' }).id)
  assert.ok(!first.id.includes('token=') && !first.title.includes('token='))
  assert.equal(internalTabTarget(instance, '工作').title, '工作', '属于启动项的实例用启动项名称做标题')
  assert.equal(internalTabTarget(instance, '工作').id, first.id, '标题不参与标签身份')
  assert.equal(first.title, 'web · 1.0.0', '没有启动项时退回 profile · 版本')
})

// Electron 运行时下载跟自更新同一套候选：国内加速是镜像优先、直连兜底
test('运行时镜像候选与下载源一致', () => {
  assert.deepEqual(updateUrlCandidates('https://github.com/electron/electron/releases/download/x.zip', 'direct'), [
    'https://github.com/electron/electron/releases/download/x.zip',
  ])
  const mirror = updateUrlCandidates('https://github.com/electron/electron/releases/download/x.zip', 'mirror')
  assert.equal(mirror.length, 3)
  assert.equal(mirror.at(-1), 'https://github.com/electron/electron/releases/download/x.zip')
  assert.equal(DEFAULT_UPDATE_SOURCE, 'mirror')
})
