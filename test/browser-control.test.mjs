/**
 * 内置浏览器（设置页「浏览器控制」）的两端约定：核心管 agent 插件开关与两个清理路由，
 * 外壳管证书策略和真正的数据清理。
 *
 * 外壳依赖 Electron（node --test 里加载不了），这里按仓库惯例做结构检查；
 * 开关本身的读写语义在 test/system-prefs.test.mjs 与 test/shell-prefs.test.mjs 里。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

const server = read('server.js')
const main = read('shell/main.mjs')
const guests = read('shell/browser-guests.mjs')

test('「启用内置浏览器控制」管 agent 工具：开着补装插件，关掉给已装的插件补一行 disabled', () => {
  assert.match(server, /const AGENT_BROWSER_PLUGIN = 'dsh-x-sidebar-browser'/, '插件名只写一处')
  // 侧栏 Browser 本身始终放开（用户手动看网页不受开关影响）
  assert.match(server, /- id: ui-sidebar-browser\\n  disabled: false\\n/, 'ui-sidebar-browser 始终放开')
  assert.match(server, /const disableAgent = !enabled && profileHasPlugin\(profile, AGENT_BROWSER_PLUGIN\)/, '关掉时只对已装插件补禁用行')
  assert.match(server, /- id: \$\{AGENT_BROWSER_PLUGIN\}\\n  disabled: true/, '禁用行')
  assert.match(server, /if \(enabled && CONTEXT_MENU && String\(profile \?\? ''\)\.toLowerCase\(\) === 'desktop'\) return \[\]/, 'desktop profile 两个开关都开着才不用补丁')
  assert.match(server, /\.filter\(\(plugin\) => plugin\.name !== AGENT_BROWSER_PLUGIN \|\| BROWSER_CONTROL\)/, '关掉后不再补装 agent 工具')
  assert.match(server, /BROWSER_CONTROL = loadSettingsSync\(\)\.browserControl !== false/, '模块初始化读设置')
  assert.match(server, /BROWSER_CONTROL = stored\.browserControl !== false/, '保存后立即更新（下一次启动实例就用新值）')
})

test('设置接口回显两个键和外壳能力字段，保存走统一布尔语义', () => {
  assert.match(server, /browserControl: stored\.browserControl !== false/)
  assert.match(server, /browserIgnoreCertificate: stored\.browserIgnoreCertificate === true/)
  assert.match(server, /browserHost: Boolean\(host\.browser\)/, '页面据它决定清理按钮能不能点')
  assert.match(server, /\('browserControl' in body \? \{ browserControl: body\.browserControl !== false \}/)
  assert.match(server, /\('browserIgnoreCertificate' in body \? \{ browserIgnoreCertificate: body\.browserIgnoreCertificate === true \}/)
})

test('清理路由只转发给外壳：没有 host.browser 时 503，不让浏览器模式假装成功', () => {
  assert.match(
    server,
    /url\.pathname === '\/api\/browser\/clear-cache' \|\| url\.pathname === '\/api\/browser\/clear-data'/,
    '两条 POST 路由',
  )
  assert.match(server, /if \(!host\.browser\) \{[\s\S]{0,220}?send\(res, 503/, '没有外壳能力返回 503')
  assert.match(server, /const action = url\.pathname\.endsWith\('\/clear-cache'\) \? 'clearCache' : 'clearAll'/, '按路径分派')
})

test('外壳：证书策略在分区创建时套一次、清理只扫内置浏览器分区（开关不拦侧栏浏览器）', () => {
  assert.doesNotMatch(main, /disabled by settings/, '侧栏 Browser 不因开关被拦：开关关的是 agent 工具')
  assert.doesNotMatch(main, /syncCertificatePolicy/, '证书策略不跟外壳轮询：改设置后重启启动器生效')
  assert.match(main, /ignoreCertificateErrors: \(\) => prefs\.browserIgnoreCertificate === true/, '证书策略读设置')
  assert.match(main, /entry\.name\.startsWith\('dsh-sidebar-browser-'\)/, '磁盘上以前跑过的分区也算')
  assert.match(main, /clearStorageData\(\{ storages: \['cachestorage', 'serviceworkers'\] \}\)/, '清缓存保留 Cookie 和站点数据')
  assert.match(main, /browser: \{[\s\S]{0,160}?clearCache: \(\) => clearBrowserData\('cache'\)[\s\S]{0,120}?clearAll: \(\) => clearBrowserData\('all'\)/)
})

test('证书策略：开着全放过（0），关着交回 Chromium 默认（-3）', () => {
  assert.match(guests, /if \(this\.ignoreCertificateErrors\(\)\) browserSession\.setCertificateVerifyProc\(\(_request, callback\) => callback\(0\)\)/)
  assert.match(guests, /else browserSession\.setCertificateVerifyProc\(\(_request, callback\) => callback\(-3\)\)/)
  assert.match(guests, /this\.applyCertificatePolicy\(browserSession\)/, '新分区创建时套策略')
  assert.doesNotMatch(guests, /syncCertificatePolicy/, '不做热切换，改设置后重启启动器')
})
