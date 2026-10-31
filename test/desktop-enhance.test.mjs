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
const css = read('public/launcher.css')
const settings = read('settings.js')

test('启动不再自动补装任何插件', () => {
  assert.doesNotMatch(server, /ensureDesktopPlugins/, '启动路径里没有自动安装')
  assert.doesNotMatch(server, /desktopPluginsToInstall/, '不再按启动版本算缺装')
})

test('安装 / 卸载两条路由：只动缺的或装了的那几个，版本不对的给失败信息', () => {
  assert.match(server, /url\.pathname === '\/api\/desktop-enhance\/install'/)
  assert.match(server, /const wanted = desktopEnhanceMissing\(profile\)/)
  assert.match(server, /await addPlugin\(version, `\$\{plugin\.name\}@\$\{plugin\.spec\}`, \{ profile \}\)/)
  assert.match(server, /versionAtLeast\(version, plugin\.minDsh\)/, '内核版本不够时跳过并报原因')
  assert.match(server, /desktopEnhance: desktopEnhanceSummary\(profile\)/, '响应里带安装进度')
  assert.match(server, /url\.pathname === '\/api\/desktop-enhance\/uninstall'/, '一键卸载路由')
  assert.match(server, /runPluginCommand\(version, \['remove', plugin\.name\]/, '走 dsh plugin remove')
  assert.match(server, /removeBundleMounted\(profileDirOf\(profile\), \[plugin\.name\]\)/, '同时从层栈摘掉')
})

test('设置接口回显安装进度（设置页按钮据此显示安装 / 已安装）', () => {
  assert.match(server, /desktopEnhance: desktopEnhanceSummary\(\)/)
  assert.match(server, /function desktopEnhanceSummary\(profile = PROFILE_NAME\)/)
})

test('设置页：桌面增强一块 + 右侧安装按钮 + 中英文案', () => {
  assert.match(page, /data-i18n="桌面增强"/)
  assert.match(page, /id="desktopEnhanceInstall" type="button"><span class="desktop-enhance-label" data-i18n="一键安装">/)
  assert.match(page, /function showDesktopEnhance\(state\)/)
  assert.match(page, /desktopEnhanceLabelEl\.textContent = desktopEnhanceDone \? t\('一键卸载'\) : t\('一键安装'\)/)
  assert.match(page, /desktopEnhanceEl\.classList\.add\('loading'\)/, '安装 / 卸载时按钮转圈')
  assert.match(css, /#desktopEnhanceInstall\.loading \.desktop-enhance-label \{ visibility: hidden; \}/, '转圈时藏文字')
  assert.match(page, /await appConfirm\(/, '卸载前先确认（样式化弹窗，不是原生 alert）')
  assert.match(page, /post\(uninstall \? '\/api\/desktop-enhance\/uninstall' : '\/api\/desktop-enhance\/install', \{\}\)/)
  const dict = new Function(`return (${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`)()
  for (const key of ['桌面增强', '安装桌面增强', '一键安装', '一键卸载', '正在安装…', '正在卸载…', '已安装', '操作失败：{error}']) {
    assert.ok(dict[key], `「${key}」有英文`)
  }
})

test('右键菜单 / 浏览器控制不再有独立开关：只有安装 + 插件页开关', () => {
  assert.doesNotMatch(settings, /contextMenu/, '设置里没有右键菜单键')
  assert.doesNotMatch(settings, /browserControl/, '设置里没有浏览器总开关')
  assert.doesNotMatch(page, /data-category="browser"/, '浏览器控制不再是独立分类')
  assert.doesNotMatch(page, /id="contextMenu"/, '右键菜单开关已撤')
})
