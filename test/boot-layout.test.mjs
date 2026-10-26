import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { switchBootAppVersion, switchBootRuntimeVersion } from '../server.js'

/** 造一个引导器布局：runtime/<v>/resources/app → app/<v>，外加 current.json。 */
function layout() {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-boot-layout-'))
  const installRoot = join(root, 'DSH')
  const appDir = join(installRoot, 'app', '0.1.20')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'server.js'), 'old\n')
  const link = join(installRoot, 'runtime', '44.7.0', 'resources', 'app')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(appDir, link, 'junction')
  const currentPath = join(installRoot, 'current.json')
  writeFileSync(currentPath, JSON.stringify({ runtime: '44.7.0', app: '0.1.20' }))
  return { root, installRoot, link, currentPath }
}

test('切换 app 版本：搬目录、重指 junction、current.json 带 previous', () => {
  const { root, installRoot, link, currentPath } = layout()
  try {
    const staged = join(root, 'staged-app')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'server.js'), 'new\n')
    const next = switchBootAppVersion({ link, installRoot, currentPath }, '0.1.21', staged)
    assert.equal(readFileSync(join(installRoot, 'app', '0.1.21', 'server.js'), 'utf8'), 'new\n')
    assert.equal(readFileSync(join(link, 'server.js'), 'utf8'), 'new\n', 'junction 指向新版本')
    assert.deepEqual(next, { runtime: '44.7.0', app: '0.1.21', previous: { runtime: '44.7.0', app: '0.1.20' } })
    assert.deepEqual(JSON.parse(readFileSync(currentPath, 'utf8')), next)
    assert.ok(existsSync(join(installRoot, 'app', '0.1.20')), '旧版本目录保留，回滚用')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('切换 runtime 版本：新 runtime 的 junction 指回当前 app，旧 runtime 保留', () => {
  const { root, installRoot, link, currentPath } = layout()
  try {
    const staged = join(root, 'staged-runtime')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'DSH.exe'), 'exe')
    const next = switchBootRuntimeVersion({
      link,
      installRoot,
      currentPath,
      appTarget: realpathSync.native(link),
    }, '44.8.0', staged)
    assert.equal(readFileSync(join(installRoot, 'runtime', '44.8.0', 'DSH.exe'), 'utf8'), 'exe')
    assert.equal(readFileSync(join(installRoot, 'runtime', '44.8.0', 'resources', 'app', 'server.js'), 'utf8'), 'old\n', '新 runtime 指回当前 app')
    assert.deepEqual(next, { runtime: '44.8.0', app: '0.1.20', previous: { runtime: '44.7.0', app: '0.1.20' } })
    assert.ok(existsSync(join(installRoot, 'runtime', '44.7.0')), '旧 runtime 目录保留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
