import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildAppAssets, verifyAppArchive } from '../scripts/app-manifest.mjs'

const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}

test('应用清单与整包：逐文件哈希、签名可校验', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-app-assets-'))
  try {
    const app = join(root, 'app')
    mkdirSync(join(app, 'shell'), { recursive: true })
    writeFileSync(join(app, 'server.js'), 'console.log(1)\n')
    writeFileSync(join(app, 'shell', 'main.mjs'), 'export {}\n')
    const { publicKeyPem, privateKeyPem } = keyPair()
    const result = await buildAppAssets({ appDir: app, version: '9.9.9', platform: 'win', outDir: root, privateKeyPem })
    assert.deepEqual(result.manifest.files.map((file) => file.path), ['server.js', 'shell/main.mjs'])
    assert.ok(result.sigPath, '有私钥就要出签名')
    assert.equal(result.manifest.archive.name, 'app-9.9.9-win.zip')
    assert.equal(result.manifest.platform, 'win')
    assert.ok(!('electronVersion' in result.manifest), '安装包不带 Electron，清单里也没有 electronVersion')
    assert.ok(!('boot' in result.manifest), 'lite 引导器退役，清单里不再有 boot')
    const manifest = await verifyAppArchive({ manifestPath: result.manifestPath, zipPath: result.zipPath, sigPath: result.sigPath, publicKeyPem })
    assert.equal(manifest.version, '9.9.9')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('清单被改一个字节，签名校验就失败', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-app-assets-'))
  try {
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'server.js'), 'x\n')
    const { publicKeyPem, privateKeyPem } = keyPair()
    const result = await buildAppAssets({ appDir: app, version: '1.0.0', outDir: root, privateKeyPem })
    const tampered = readFileSync(result.manifestPath, 'utf8').replace('"1.0.0"', '"1.0.1"')
    writeFileSync(result.manifestPath, tampered)
    await assert.rejects(
      verifyAppArchive({ manifestPath: result.manifestPath, zipPath: result.zipPath, sigPath: result.sigPath, publicKeyPem }),
      /签名校验失败/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('zip 与清单不一致（文件被换掉）也会被发现', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-app-assets-'))
  try {
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'server.js'), 'ok\n')
    const result = await buildAppAssets({ appDir: app, version: '1.0.0', outDir: root })
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    manifest.files[0].sha256 = '0'.repeat(64)
    writeFileSync(result.manifestPath, JSON.stringify(manifest))
    await assert.rejects(
      verifyAppArchive({ manifestPath: result.manifestPath, zipPath: result.zipPath }),
      /与清单不一致/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
