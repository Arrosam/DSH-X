import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  DESKTOP_PLUGINS,
  DESKTOP_PLUGINS_SKIP_PROFILES,
  desktopPluginsForDsh,
  desktopPluginsToInstall,
  parseDshVersion,
  versionAtLeast,
} from '../desktop-plugins.js'

test('版本解析：只认 x.y.z，预发布后缀丢掉', () => {
  assert.deepEqual(parseDshVersion('0.2.2-alpha.2'), [0, 2, 2])
  assert.deepEqual(parseDshVersion('0.2.0'), [0, 2, 0])
  assert.deepEqual(parseDshVersion(' 1.0.0-rc.1 '), [1, 0, 0])
  assert.equal(parseDshVersion('latest'), null)
  assert.equal(parseDshVersion(''), null)
  assert.equal(parseDshVersion(undefined), null)
})

test('版本门槛：同版本的预发布算满足', () => {
  assert.equal(versionAtLeast('0.2.0', '0.2.0'), true)
  assert.equal(versionAtLeast('0.2.0-rc.4', '0.2.0'), true)
  assert.equal(versionAtLeast('0.2.1-rc.4', '0.2.1-rc.2'), true)
  assert.equal(versionAtLeast('0.2.2-alpha.2', '0.2.1-rc.2'), true)
  assert.equal(versionAtLeast('0.3.0', '0.2.1-rc.2'), true)
  assert.equal(versionAtLeast('0.1.21', '0.2.0'), false)
  assert.equal(versionAtLeast('0.2.0-rc.1', '0.2.1-rc.2'), false)
  // 认不出版本就不装：宁可不装，也别把插件塞进不认识的内核
  assert.equal(versionAtLeast('', '0.2.0'), false)
  assert.equal(versionAtLeast('0.2.2-alpha.2', ''), false)
})

test('按内核版本挑插件：0.1.x 一个都不装，0.2.1 起三个都能装', () => {
  assert.deepEqual(desktopPluginsForDsh('0.1.21'), [])
  assert.deepEqual(
    desktopPluginsForDsh('0.2.0-rc.1').map((plugin) => plugin.name),
    ['dsh-x-desktop-notify', 'dsh-x-context-menu'],
  )
  assert.deepEqual(
    desktopPluginsForDsh('0.2.2-alpha.2').map((plugin) => plugin.name),
    ['dsh-x-desktop-notify', 'dsh-x-context-menu', 'dsh-x-sidebar-browser'],
  )
})

test('缺装判断：dependencies 里有就算装了，link / file 安装不换成 npm 版', () => {
  const all = desktopPluginsToInstall({}, '0.2.2-alpha.2').map((plugin) => plugin.name)
  assert.deepEqual(all, ['dsh-x-desktop-notify', 'dsh-x-context-menu', 'dsh-x-sidebar-browser'])

  const partial = desktopPluginsToInstall(
    { dependencies: { 'dsh-x-context-menu': 'link:C:/somewhere/dsh-x-context-menu' } },
    '0.2.2-alpha.2',
  ).map((plugin) => plugin.name)
  assert.deepEqual(partial, ['dsh-x-desktop-notify', 'dsh-x-sidebar-browser'])

  const full = desktopPluginsToInstall(
    {
      dependencies: {
        'dsh-x-desktop-notify': '^0.1.0',
        'dsh-x-context-menu': '^0.1.0',
        'dsh-x-sidebar-browser': '^0.1.0',
      },
    },
    '0.2.2-alpha.2',
  )
  assert.deepEqual(full, [])

  // 脏清单按「什么都没装」处理，不让一个坏 profile 拦住启动
  assert.equal(desktopPluginsToInstall({ dependencies: 'nope' }, '0.2.2-alpha.2').length, 3)
  assert.equal(desktopPluginsToInstall(null, '0.2.2-alpha.2').length, 3)
})

test('清单和仓库里的插件对得上：包名、版本、命名都在', () => {
  for (const plugin of DESKTOP_PLUGINS) {
    const dir = join(import.meta.dirname, '..', 'plugins', plugin.name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(manifest.name, plugin.name)
    // 自动安装钉的版本必须就是仓库里的版本，否则装到的是旧包
    assert.equal(manifest.version, plugin.spec)
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    const range = String(manifest.dsh?.compatibility?.dsh ?? '')
    assert.ok(range.length > 0, `${plugin.name} 缺 dsh.compatibility.dsh`)
    assert.ok(range.includes(plugin.minDsh), `${plugin.name} 的 compatibility 下限与 ${plugin.minDsh} 不一致`)
    // 插件页的名字来自 meta.title（locale 覆盖）；三个包都填了才不会显示裸包名
    assert.ok(manifest.meta?.title, `${plugin.name} 缺 meta.title`)
    assert.ok(manifest.meta?.description, `${plugin.name} 缺 meta.description`)
    for (const lang of ['zh', 'en']) {
      const locale = JSON.parse(readFileSync(join(dir, 'locale', `${lang}.json`), 'utf8'))
      assert.ok(locale.meta?.title, `${plugin.name} 缺 locale/${lang}.json 的 meta.title`)
      assert.ok(locale.meta?.description, `${plugin.name} 缺 locale/${lang}.json 的 meta.description`)
    }
  }
})

test('desktop profile 不归 DSH-X 管', () => {
  assert.deepEqual(DESKTOP_PLUGINS_SKIP_PROFILES, ['desktop'])
})
