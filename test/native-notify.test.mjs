import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyNativeNotify, profileHasNativeNotify } from '../native-notify.js'

/** 建一个 DSH_HOME：profiles/<名字>/package.json，可选补丁层。 */
function homeWith(profiles) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-native-notify-'))
  mkdirSync(join(home, 'profiles'))
  for (const [name, entry] of Object.entries(profiles)) {
    const dir = join(home, 'profiles', name)
    mkdirSync(dir)
    if (entry.package !== undefined) {
      writeFileSync(join(dir, 'package.json'), typeof entry.package === 'string' ? entry.package : JSON.stringify(entry.package, null, 2))
    }
    if (entry.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), entry.patch)
  }
  return home
}

const groupProfile = {
  name: 'dsh-profile-a',
  private: true,
  dependencies: { 'dsh-x-desktop-bundle': '^0.1.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-x-desktop-bundle'] } },
}

test('装了桌面组：关 → 写禁用块，开 → 删掉', () => {
  const home = homeWith({ a: { package: groupProfile } })
  const off = applyNativeNotify(home, false)
  assert.equal(off.changed, 1)
  assert.deepEqual(off.profiles, ['a'])
  const patch = readFileSync(join(home, 'profiles', 'a', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: x-desktop-notify/)
  assert.match(patch, /  disabled: true/)

  assert.equal(applyNativeNotify(home, false).changed, 0, '再关一次不变')

  const on = applyNativeNotify(home, true)
  assert.equal(on.changed, 1)
  const restored = readFileSync(join(home, 'profiles', 'a', 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(restored, /disabled: true/)
})

test('装了单体插件：同样归开关管', () => {
  const home = homeWith({ b: { package: { dependencies: { 'dsh-x-desktop-notify': '0.1.0' } } } })
  assert.equal(applyNativeNotify(home, false).changed, 1)
  assert.match(readFileSync(join(home, 'profiles', 'b', 'cordis.patch.yml'), 'utf8'), /disabled: true/)
})

test('没装的环境不写覆盖（以后装组不会一上来就停用）', () => {
  const home = homeWith({ c: { package: { dependencies: {} }, patch: '- id: other-row\n  disabled: true\n' } })
  assert.equal(applyNativeNotify(home, false).changed, 0)
  assert.equal(readFileSync(join(home, 'profiles', 'c', 'cordis.patch.yml'), 'utf8'), '- id: other-row\n  disabled: true\n')
})

test('坏清单与坏补丁层跳过，不影响别的环境', () => {
  const home = homeWith({
    bad: { package: '{ not json' },
    broken: { package: groupProfile, patch: 'kept: as object\n' },
    good: { package: groupProfile },
  })
  const result = applyNativeNotify(home, false)
  assert.deepEqual(result.profiles, ['good'])
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].profile, 'broken')
  assert.equal(readFileSync(join(home, 'profiles', 'broken', 'cordis.patch.yml'), 'utf8'), 'kept: as object\n', '坏补丁层原样保留')
})

test('profiles 目录不存在：空结果，不抛异常', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-native-notify-empty-'))
  assert.deepEqual(applyNativeNotify(home, false), { home, changed: 0, profiles: [], failed: [] })
})

test('识别：组、单体、都不是', () => {
  assert.equal(profileHasNativeNotify({ dependencies: { 'dsh-x-desktop-bundle': '^0.1.0' } }), true)
  assert.equal(profileHasNativeNotify({ dependencies: { 'dsh-x-desktop-notify': '0.1.0' } }), true)
  assert.equal(profileHasNativeNotify({ dependencies: { 'dsh-x-memory': '^0.1.0' } }), false)
  assert.equal(profileHasNativeNotify({}), false)
  assert.equal(profileHasNativeNotify(null), false)
})
