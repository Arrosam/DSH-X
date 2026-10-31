/**
 * 设置 → 常规 → 桌面增强：右侧「一键安装」把三个首方插件装进当前 profile。
 *
 * 和以前「启动时自动补装」的区别：不点不装，装完在 dsh 插件页单独开关。
 * 这里按仓库惯例做结构检查（真装插件要跑 pnpm，单测不碰网络）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const server = read('server.js')
const page = read('public/index.html')
const settings = read('settings.js')

test('启动不再自动补装任何插件', () => {
  assert.doesNotMatch(server, /ensureDesktopPlugins/, '启动路径里没有自动安装')
  assert.doesNotMatch(server, /desktopPluginsToInstall/, '不再按启动版本算缺装')
})

test('安装路由存在：只装缺的，版本不对的给失败信息，不拦别的插件', () => {
  assert.match(server, /url\.pathname === '\/api\/desktop-enhance\/install'/)
  assert.match(server, /const wanted = desktopEnhanceMissing\(profile\)/)
  assert.match(server, /await addPlugin\(version, `\$\{plugin\.name\}@\$\{plugin\.spec\}`, \{ profile \}\)/)
  assert.match(server, /versionAtLeast\(version, plugin\.minDsh\)/, '内核版本不够时跳过并报原因')
  assert.match(server, /desktopEnhance: desktopEnhanceSummary\(profile\)/, '响应里带安装进度')
})

test('设置接口回显安装进度（设置页按钮据此显示安装 / 已安装）', () => {
  assert.match(server, /desktopEnhance: desktopEnhanceSummary\(\)/)
  assert.match(server, /function desktopEnhanceSummary\(profile = PROFILE_NAME\)/)
})

test('设置页：桌面增强一块 + 右侧安装按钮 + 中英文案', () => {
  assert.match(page, /data-i18n="桌面增强"/)
  assert.match(page, /id="desktopEnhanceInstall" type="button" data-i18n="一键安装"/)
  assert.match(page, /post\('\/api\/desktop-enhance\/install', \{\}\)/)
  assert.match(page, /function showDesktopEnhance\(state\)/)
  assert.match(page, /desktopEnhanceEl\.textContent = done \? t\('已安装'\) : t\('一键安装'\)/)
  const dict = new Function(`return (${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`)()
  for (const key of ['桌面增强', '安装桌面增强', '一键安装', '正在安装…', '已安装', '安装失败：{error}']) {
    assert.ok(dict[key], `「${key}」有英文`)
  }
})

test('右键菜单 / 浏览器控制不再有独立开关：只有安装 + 插件页开关', () => {
  assert.doesNotMatch(settings, /contextMenu/, '设置里没有右键菜单键')
  assert.doesNotMatch(settings, /browserControl/, '设置里没有浏览器总开关')
  assert.doesNotMatch(page, /data-category="browser"/, '浏览器控制不再是独立分类')
  assert.doesNotMatch(page, /id="contextMenu"/, '右键菜单开关已撤')
})
