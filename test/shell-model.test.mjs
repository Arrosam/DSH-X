/**
 * 标签窗口里与 Electron 无关的规则：地址判定、/api/tray 解析、标签条消息校验、标题清洗、重排。
 * 期望值取自旧 Rust 外壳的同名用例（launcher/tabs.rs、tray.rs 的 tests）与旧版 Electron 外壳：
 * 几个外壳对管理服务说的是同一套协议，规则必须一致。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isExternalWebUrl,
  isLoopbackUrl,
  normalizePageTitle,
  PAGE_TITLE_MAX,
  parseTabAction,
  parseTabTarget,
  parseTrayState,
  reorderBy,
  sameOrigin,
} from '../shell/model.mjs'
import { runtimeNode, runtimeNodeEnv } from '../platform.js'
import { resolveDark, stoppedPage } from '../shell/pages.mjs'

test('停止页跟随主题与系统深浅色（#58，和 tabs.rs 的同名用例一致）', () => {
  assert.ok(resolveDark('dark', false) && resolveDark('dark', true))
  assert.ok(!resolveDark('light', false) && !resolveDark('light', true))
  assert.ok(!resolveDark('system', false) && resolveDark('system', true))
  assert.ok(resolveDark('', true), '缺 theme 行时按跟随系统处理')
  assert.ok(stoppedPage('zh', false).includes('background:#f5f8ff'))
  const dark = stoppedPage('zh', true)
  assert.ok(dark.includes('background:#15171c') && !dark.includes('#f5f8ff'), '深色停止页不能带浅色底')
  const en = stoppedPage('en', true)
  assert.ok(en.includes('This DSH instance has stopped.') && !en.includes('此 DSH'), '英文界面不能冒出中文')
})

test('本机地址判定：只认回环，userinfo 里的主机名骗不过去', () => {
  assert.ok(isLoopbackUrl('http://127.0.0.1:9716/?token=a'))
  assert.ok(isLoopbackUrl('http://localhost/'))
  assert.ok(isLoopbackUrl('http://[::1]:80/'))
  assert.ok(!isLoopbackUrl('http://127.0.0.1@evil.example/'))
  assert.ok(!isLoopbackUrl('https://example.com/'))
  assert.ok(!isLoopbackUrl('data:text/html,hi'))
  assert.ok(isExternalWebUrl('https://github.com/yyh-001/DSH-X'))
  assert.ok(!isExternalWebUrl('http://127.0.0.1:3780/'))
  // data:/blob: 不是外部网页：交给系统只会弹「用什么打开」
  assert.ok(!isExternalWebUrl('data:text/html,hi'))
  assert.ok(sameOrigin('http://127.0.0.1:1/a?b', 'HTTP://127.0.0.1:1/'))
  assert.ok(!sameOrigin('http://127.0.0.1:1/', 'http://127.0.0.1:2/'))
  assert.ok(!sameOrigin('about:blank', 'about:blank'))
})

test('标签目标保留认证地址，拒收外部地址', () => {
  const target = parseTabTarget({ id: 'web@1', title: 'web · 1', url: 'http://127.0.0.1:1234/?token=abc&x=2' })
  assert.ok(target.url.endsWith('token=abc&x=2'))
  assert.equal(target.managed, true)
  assert.equal(parseTabTarget({ id: 'x', url: 'https://example.com/' }), null)
  assert.equal(parseTabTarget({ id: '', url: 'http://127.0.0.1/' }), null)
})

test('/api/tray 解析：实例逐项校验，坏行不影响其余字段', () => {
  const state = parseTrayState([
    'status=running',
    'lang=en',
    'openmode=internal',
    'shell=1',
    'theme=dark',
    `instances=${JSON.stringify([{ id: 'a', url: 'http://127.0.0.1:1/?token=t' }, { id: 'b', url: 'https://example.com/' }])}`,
    'launches=not json',
  ].join('\n'))
  assert.equal(state.status, 'running')
  assert.equal(state.lang, 'en')
  assert.equal(state.theme, 'dark')
  assert.equal(state.openmode, 'internal')
  assert.equal(state.shell, true)
  assert.deepEqual(state.instances.map((item) => item.id), ['a'])
  // 标签窗口不再用启动项菜单，launches 行随便什么内容都不该影响实例解析
  assert.equal(parseTrayState('').instances.length, 0)
})

test('标签条消息：只认标签窗口自己会发的动作，脏字段一律拒绝', () => {
  assert.deepEqual(parseTabAction('{"action":"select","id":""}'), { action: 'select', id: '' })
  assert.equal(parseTabAction('{"action":"launch"}'), null)
  assert.equal(parseTabAction('{"action":"select"}'), null)
  assert.deepEqual(parseTabAction('{"action":"select","id":"web","request":2}'), { action: 'select', id: 'web', request: 2 })
  assert.equal(parseTabAction('{"action":"select","id":"web","request":-1}'), null)
  assert.deepEqual(parseTabAction('{"action":"close-tab","id":"web"}'), { action: 'close-tab', id: 'web' })
  assert.deepEqual(parseTabAction('{"action":"reload"}'), { action: 'reload' })
  assert.deepEqual(parseTabAction('{"action":"present","serial":3}'), { action: 'present', serial: 3 })
  assert.equal(parseTabAction('{"action":"present","serial":-1}'), null)
  // 旧管理页那套消息（窗口按钮、布局高度、弹窗遮挡）在标签窗口里不再存在
  assert.equal(parseTabAction('minimize'), null)
  assert.equal(parseTabAction('{"action":"layout","height":72}'), null)
  assert.equal(parseTabAction('{"action":"overlay","open":true}'), null)
})

test('排序消息校验 id，并让新开的标签留在末尾', () => {
  assert.deepEqual(parseTabAction('{"action":"reorder","ids":["second","first"],"request":3}'), { action: 'reorder', ids: ['second', 'first'], request: 3 })
  for (const body of [
    '{"action":"reorder","ids":["first","first"],"request":3}',
    '{"action":"reorder","ids":[""],"request":3}',
    '{"action":"reorder","ids":[1],"request":3}',
    '{"action":"reorder","ids":[],"request":-1}',
  ]) assert.equal(parseTabAction(body), null, body)
  const ids = reorderBy(['first', 'new-a', 'second', 'new-b'], ['closed', 'second', 'first'], (id) => id)
  assert.deepEqual(ids, ['second', 'first', 'new-a', 'new-b'])
})

test('页面标题清洗：控制字符去掉，长度封顶（标题来自远端页面）', () => {
  assert.equal(normalizePageTitle('  DSH  '), '  DSH  ', '首尾空白由窗口标题那边 trim，这里不动')
  assert.equal(normalizePageTitle('a\u0000b\u001fc\nd'), 'abcd')
  assert.equal(normalizePageTitle(undefined), '')
  assert.equal(normalizePageTitle('x'.repeat(PAGE_TITLE_MAX + 20)).length, PAGE_TITLE_MAX)
})

test('Electron 外壳里，dsh 子进程用 Electron 自带的 Node（旧包仍认 node/node.exe）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-node-'))
  try {
    // 不在 Electron 里：就是正在跑的 node
    assert.equal(runtimeNode({}, root, false), process.execPath)
    // 显式指定优先
    assert.equal(runtimeNode({ DSH_RUNTIME_NODE: '/custom/node' }, root, true), '/custom/node')
    // 打包后没有自带 node：就是 Electron 本体（加 ELECTRON_RUN_AS_NODE 环境变量）
    assert.equal(runtimeNode({ PATH: '' }, root, true), process.execPath)
    // 0.1.19 及更早的安装包里有 node/node.exe：继续优先用它
    mkdirSync(join(root, 'node'))
    const legacy = join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    writeFileSync(legacy, '')
    assert.equal(runtimeNode({ PATH: '' }, root, true), legacy)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RUNTIME_NODE_ENV：只有落到 Electron 本体时才补 ELECTRON_RUN_AS_NODE', () => {
  assert.deepEqual(runtimeNodeEnv('/app/DSH.exe', '/app/DSH.exe', true), { ELECTRON_RUN_AS_NODE: '1' })
  // Windows 路径大小写不敏感
  if (process.platform === 'win32') assert.deepEqual(runtimeNodeEnv('C:\\App\\dsh.exe', 'c:\\APP\\DSH.exe', true), { ELECTRON_RUN_AS_NODE: '1' })
  // 旧安装包的 node.exe、或根本不在 Electron 里：什么都不用设
  assert.deepEqual(runtimeNodeEnv('/app/node/node.exe', '/app/DSH.exe', true), {})
  assert.deepEqual(runtimeNodeEnv('/app/DSH.exe', '/app/DSH.exe', false), {})
})
