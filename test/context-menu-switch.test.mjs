/**
 * 「右键菜单」开关（设置 → 常规）：核心在启动补丁里停用 dsh-x-context-menu 的 loader 行，
 * 关掉时也不再自动补装；不卸载包、不动依赖。
 *
 * 和「启用内置浏览器控制」同一套做法（同一个 --patch 文件），这里按仓库惯例做结构检查。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const server = read('server.js')
const settings = read('settings.js')
const page = read('public/index.html')
const patch = read('plugins/dsh-x-context-menu/cordis.patch.yml')

test('默认开、按统一布尔语义保存', () => {
  assert.match(settings, /contextMenu: true,/)
  assert.match(settings, /merged\.contextMenu = merged\.contextMenu !== false/)
  assert.match(server, /let CONTEXT_MENU = loadSettingsSync\(\)\.contextMenu !== false/)
  assert.match(server, /CONTEXT_MENU = stored\.contextMenu !== false/)
})

test('设置接口回显与保存都认这个键', () => {
  assert.match(server, /contextMenu: stored\.contextMenu !== false/)
  assert.match(server, /\('contextMenu' in body \? \{ contextMenu: body\.contextMenu !== false \}/)
})

test('关掉时启动补丁停用插件行，且只对装过的环境写', () => {
  assert.match(server, /const CONTEXT_MENU_ROW_ID = 'x-context-menu'/, '行 id 只写一处')
  assert.match(server, /const disableContextMenu = !CONTEXT_MENU && profileHasPlugin\(profile, CONTEXT_MENU_PLUGIN\)/)
  assert.match(server, /- id: \$\{CONTEXT_MENU_ROW_ID\}\\n  disabled: true/, '禁用行')
  // 行 id 必须和插件自己的 patch 对得上，否则补丁匹配不到、静默失效
  assert.match(patch, /id: x-context-menu/)
})

test('关掉后不再自动补装', () => {
  assert.match(server, /const CONTEXT_MENU_PLUGIN = 'dsh-x-context-menu'/)
  assert.match(server, /\.filter\(\(plugin\) => plugin\.name !== CONTEXT_MENU_PLUGIN \|\| CONTEXT_MENU\)/)
})

test('设置页有开关，中英文文案齐全', () => {
  assert.match(page, /<input id="contextMenu" type="checkbox" \/>/)
  assert.match(page, /data-i18n="启用右键菜单"/)
  assert.match(page, /"右键菜单": "Context menu"/)
  assert.match(page, /"启用右键菜单": "Enable context menu"/)
  assert.match(page, /contextMenuEl\.onchange = \(\) => queueSetting\('contextMenu', contextMenuEl\.checked\)/)
  // 保存失败要回滚勾选，别让人以为已经生效
  assert.match(page, /contextMenuEl\.checked = savedContextMenu/)
})
