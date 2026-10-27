import assert from 'node:assert/strict'
import { createHash, createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertManifestShape, extractVerified, localDiff, verifyAppManifest } from '../app-update.js'
import { buildAppAssets } from '../scripts/app-manifest.mjs'

const tempRoot = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-app-update-'))
const sha = (text) => createHash('sha256').update(text).digest('hex')

test('本地对比：只报缺失或哈希不同的文件，清单外的文件不碰', () => {
  const root = tempRoot()
  try {
    const app = join(root, 'app')
    mkdirSync(join(app, 'shell'), { recursive: true })
    mkdirSync(join(app, 'data'), { recursive: true })
    writeFileSync(join(app, 'server.js'), 'old\n')
    writeFileSync(join(app, 'shell', 'main.mjs'), 'same\n')
    writeFileSync(join(app, 'data', 'user.json'), '{}')
    const manifest = {
      schema: 'dsh-x.app/v1',
      version: '9.9.9',
      platform: 'win',
      electronVersion: '44.7.0',
      files: [
        { path: 'server.js', size: 4, sha256: sha('new\n') },
        { path: 'shell/main.mjs', size: 5, sha256: sha('same\n') },
        { path: 'shell/extra.mjs', size: 1, sha256: sha('x') },
      ],
    }
    const diff = localDiff(app, manifest)
    assert.deepEqual(diff.files.map((file) => file.path).sort(), ['server.js', 'shell/extra.mjs'])
    assert.equal(diff.changed, 2)
    if (process.platform !== 'win32') {
      // 内容一样但可执行位丢了，也要算变化（mac 的包装脚本）
      chmodSync(join(app, 'server.js'), 0o755)
      const withMode = { ...manifest, files: manifest.files.map((file) => file.path === 'server.js' ? { ...file, sha256: sha('old\n'), mode: 0o755 } : file) }
      assert.ok(!localDiff(app, withMode).files.some((file) => file.path === 'server.js'))
      chmodSync(join(app, 'server.js'), 0o644)
      assert.ok(localDiff(app, withMode).files.some((file) => file.path === 'server.js'))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('清单形状：版本/平台/Electron 版本对不上要拒绝，路径穿越也要拒绝', () => {
  const base = { schema: 'dsh-x.app/v1', version: '1.0.0', platform: 'win', electronVersion: '44.7.0', files: [{ path: 'server.js', size: 1, sha256: sha('x') }] }
  assert.doesNotThrow(() => assertManifestShape(base, { version: '1.0.0', electronVersion: '44.7.0', platform: 'win' }))
  assert.throws(() => assertManifestShape({ ...base, version: '1.0.1' }, { version: '1.0.0', electronVersion: '44.7.0', platform: 'win' }), /版本/)
  assert.throws(() => assertManifestShape({ ...base, platform: 'mac' }, { version: '1.0.0', electronVersion: '44.7.0', platform: 'win' }), /平台/)
  assert.throws(() => assertManifestShape({ ...base, electronVersion: '43.0.0' }, { version: '1.0.0', electronVersion: '44.7.0', platform: 'win' }), /Electron/)
  assert.throws(() => assertManifestShape({ ...base, files: [{ path: '../evil.js', size: 1, sha256: sha('x') }] }, { version: '1.0.0', electronVersion: '44.7.0', platform: 'win' }), /非法路径/)
  assert.throws(() => assertManifestShape({ ...base, files: [{ path: '/abs.js', size: 1, sha256: sha('x') }] }, { version: '1.0.0', electronVersion: '44.7.0', platform: 'win' }), /非法路径/)
  assert.throws(() => assertManifestShape({ ...base, files: [{ path: 'x.js', size: 1, sha256: sha('x'), mode: 0o1000 }] }, { version: '1.0.0', electronVersion: '44.7.0', platform: 'win' }), /权限/)
})

test('签名校验：同一份清单用对应公钥能过，换钥匙就不过', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const { publicKey: otherPublic } = generateKeyPairSync('ed25519')
  const bytes = Buffer.from('{"a":1}')
  const signature = cryptoSign(null, bytes, privateKey).toString('base64')
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  assert.equal(verifyAppManifest(bytes, signature, pem), true)
  assert.equal(verifyAppManifest(bytes, signature, otherPublic.export({ type: 'spki', format: 'pem' })), false)
  assert.equal(verifyAppManifest(Buffer.from('{"a":2}'), signature, pem), false)
})

test('解包校验：逐个文件核对哈希，zip 与清单不一致就拒绝', async () => {
  const root = tempRoot()
  try {
    const app = join(root, 'app')
    mkdirSync(join(app, 'shell'), { recursive: true })
    mkdirSync(join(app, 'node'), { recursive: true })
    writeFileSync(join(app, 'server.js'), 'console.log(1)\n')
    writeFileSync(join(app, 'shell', 'main.mjs'), 'export {}\n')
    writeFileSync(join(app, 'node', 'node'), '#!/bin/sh\nexec "$0" "$@"\n')
    if (process.platform !== 'win32') chmodSync(join(app, 'node', 'node'), 0o755)
    const result = await buildAppAssets({ appDir: app, version: '9.9.9', electronVersion: '44.7.0', platform: 'mac', outDir: root })
    const staging = join(root, 'staging')
    await extractVerified(result.zipPath, result.manifest, staging)
    assert.equal(readFileSync(join(staging, 'server.js'), 'utf8'), 'console.log(1)\n')
    assert.equal(readFileSync(join(staging, 'shell', 'main.mjs'), 'utf8'), 'export {}\n')
    if (process.platform !== 'win32') {
      // zip 不存权限：可执行位要跟着签名清单走，否则 mac 上 node/npm/pnpm 包装脚本会失效
      assert.equal(result.manifest.files.find((file) => file.path === 'node/node').mode, 0o755)
      assert.ok(statSync(join(staging, 'node', 'node')).mode & 0o100, '解出来的包装脚本要保留执行位')
    }
    const tampered = { ...result.manifest, files: result.manifest.files.map((file) => file.path === 'server.js' ? { ...file, sha256: '0'.repeat(64) } : file) }
    await assert.rejects(extractVerified(result.zipPath, tampered, join(root, 'staging2')), /哈希与清单不一致/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('内置公钥必须与 scripts/release-pubkey.pem 一致（换钥匙时两边一起改）', async () => {
  const { APP_PUBLIC_KEY } = await import('../app-update.js')
  // Windows 检出时 PEM 会被换成 CRLF，比较前统一成 LF
  const repoKey = readFileSync(new URL('../scripts/release-pubkey.pem', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim()
  assert.equal(APP_PUBLIC_KEY.trim(), repoKey)
})

test('测试通道公钥：仓库里的测试私钥签的清单能过，正式公钥不认', async () => {
  const { APP_PUBLIC_KEY, TEST_APP_PUBLIC_KEY } = await import('../app-update.js')
  const { testReleaseKeyPem } = await import('../scripts/test-release-key.mjs')
  const privateKey = createPrivateKey(testReleaseKeyPem())
  const bytes = Buffer.from('{"test":1}')
  const signature = cryptoSign(null, bytes, privateKey).toString('base64')
  assert.equal(verifyAppManifest(bytes, signature, TEST_APP_PUBLIC_KEY), true)
  assert.equal(verifyAppManifest(bytes, signature, APP_PUBLIC_KEY), false)
  assert.equal(verifyAppManifest(bytes, signature), false, '默认必须走正式公钥')
})
