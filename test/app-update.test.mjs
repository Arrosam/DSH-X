import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    writeFileSync(join(app, 'server.js'), 'console.log(1)\n')
    writeFileSync(join(app, 'shell', 'main.mjs'), 'export {}\n')
    const result = await buildAppAssets({ appDir: app, version: '9.9.9', electronVersion: '44.7.0', platform: 'win', outDir: root })
    const staging = join(root, 'staging')
    await extractVerified(result.zipPath, result.manifest, staging)
    assert.equal(readFileSync(join(staging, 'server.js'), 'utf8'), 'console.log(1)\n')
    assert.equal(readFileSync(join(staging, 'shell', 'main.mjs'), 'utf8'), 'export {}\n')
    const tampered = { ...result.manifest, files: result.manifest.files.map((file) => file.path === 'server.js' ? { ...file, sha256: '0'.repeat(64) } : file) }
    await assert.rejects(extractVerified(result.zipPath, tampered, join(root, 'staging2')), /哈希与清单不一致/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
