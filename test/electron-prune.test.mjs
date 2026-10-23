import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { keepLocale, pruneLocales, pruneMacElectron } from '../scripts/electron-prune.mjs'

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-x-prune-'))
}

/** 造一个 Electron 44 的 mac 布局（只要裁剪关心的那几层）。 */
function makeMacApp(root) {
  const resources = join(root, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
  const libraries = join(root, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries')
  mkdirSync(resources, { recursive: true })
  mkdirSync(libraries, { recursive: true })
  mkdirSync(join(root, 'Contents', 'Resources'), { recursive: true })
  for (const locale of ['en.lproj', 'en_GB.lproj', 'en_FEMININE.lproj', 'zh_CN.lproj', 'de.lproj', 'zh_TW.lproj', 'fr_MASCULINE.lproj']) {
    mkdirSync(join(resources, locale), { recursive: true })
    writeFileSync(join(resources, locale, 'locale.pak'), Buffer.alloc(2048, 1))
  }
  writeFileSync(join(libraries, 'libvk_swiftshader.dylib'), Buffer.alloc(4096, 1))
  writeFileSync(join(libraries, 'vk_swiftshader_icd.json'), '{}')
  writeFileSync(join(root, 'Contents', 'Resources', 'default_app.asar'), Buffer.alloc(1024, 1))
  return { resources, libraries }
}

test('语言白名单：英文（含地区变体）和简体中文留下，其余裁掉', () => {
  for (const kept of ['en.lproj', 'en_GB.lproj', 'en_FEMININE.lproj', 'zh_CN.lproj', 'en', 'zh_CN']) {
    assert.equal(keepLocale(kept), true, `${kept} 应该留下`)
  }
  for (const removed of ['de.lproj', 'zh_TW.lproj', 'fr_MASCULINE.lproj', 'ja.lproj', 'zh_CN_MASCULINE.lproj']) {
    assert.equal(keepLocale(removed), false, `${removed} 应该裁掉`)
  }
})

test('pruneLocales 只删白名单外的 .lproj，并报告省下的字节数', () => {
  const root = makeRoot()
  try {
    const resources = join(root, 'Resources')
    mkdirSync(join(resources, 'en.lproj'), { recursive: true })
    mkdirSync(join(resources, 'de.lproj'), { recursive: true })
    writeFileSync(join(resources, 'en.lproj', 'locale.pak'), Buffer.alloc(100, 1))
    writeFileSync(join(resources, 'de.lproj', 'locale.pak'), Buffer.alloc(300, 1))
    writeFileSync(join(resources, 'resources.pak'), Buffer.alloc(50, 1))

    const removed = pruneLocales(resources)
    assert.equal(removed, 300)
    assert.equal(existsSync(join(resources, 'en.lproj')), true)
    assert.equal(existsSync(join(resources, 'de.lproj')), false)
    assert.equal(existsSync(join(resources, 'resources.pak')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneMacElectron 裁掉多语言、swiftshader 与占位 app，保留英文/中文', () => {
  const root = makeRoot()
  try {
    const { resources, libraries } = makeMacApp(root)
    const removed = pruneMacElectron(root)

    // 裁掉 de / zh_TW / fr_MASCULINE 各 2KB + swiftshader 4KB + icd 2B + default_app 1KB
    assert.equal(removed, 2048 * 3 + 4096 + 2 + 1024)
    for (const kept of ['en.lproj', 'en_GB.lproj', 'en_FEMININE.lproj', 'zh_CN.lproj']) {
      assert.equal(existsSync(join(resources, kept)), true, `${kept} 应该留下`)
    }
    for (const gone of ['de.lproj', 'zh_TW.lproj', 'fr_MASCULINE.lproj']) {
      assert.equal(existsSync(join(resources, gone)), false, `${gone} 应该裁掉`)
    }
    assert.equal(existsSync(join(libraries, 'libvk_swiftshader.dylib')), false)
    assert.equal(existsSync(join(libraries, 'vk_swiftshader_icd.json')), false)
    assert.equal(existsSync(join(root, 'Contents', 'Resources', 'default_app.asar')), false)
    // ffmpeg、其它库不碰
    assert.equal(existsSync(join(libraries, 'libffmpeg.dylib')), false) // 测试树里本来就没有
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keepSwiftshader 时保留软件渲染（极端环境下起不来时的退路）', () => {
  const root = makeRoot()
  try {
    const { libraries } = makeMacApp(root)
    assert.ok(pruneMacElectron(root, { keepSwiftshader: true }) > 0)
    assert.equal(existsSync(join(libraries, 'libvk_swiftshader.dylib')), true)
    assert.equal(existsSync(join(libraries, 'vk_swiftshader_icd.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
