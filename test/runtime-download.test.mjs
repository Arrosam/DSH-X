import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RUNTIME_VERSIONS } from '../platform.js'
import {
  abortError,
  downloadArchive,
  electronDownloadUrls,
  electronReleaseUrl,
  extractArchive,
  installElectronRuntime,
  isAbortError,
} from '../runtime-download.js'
import { writeZip } from '../zip.js'

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')
const tempRoot = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-runtime-download-'))
/** 系统解压工具只有 Win / mac 有（mac ditto、Windows bsdtar），别的平台跳过真实解压的用例。 */
const SYSTEM_EXTRACT = process.platform === 'darwin' || process.platform === 'win32'

/** 起一只只发固定内容的本地 HTTP 服务；返回地址与关闭函数。 */
function serve(body) {
  return new Promise((resolve) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    const requests = []
    const server = createServer((req, res) => {
      requests.push(req.url)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length })
      res.end(payload)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/archive.zip`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

test('官方发行包地址与镜像候选：GitHub 走 mirrors，本地地址原样', () => {
  const version = RUNTIME_VERSIONS.electron.version
  const file = RUNTIME_VERSIONS.electron['darwin-arm64'].file
  const url = electronReleaseUrl(version, file)
  assert.equal(url, `https://github.com/electron/electron/releases/download/v${version}/${file}`)
  const mirror = electronDownloadUrls(version, file, 'mirror')
  assert.equal(mirror.length, 3)
  assert.equal(mirror.at(-1), url, '镜像前面加，直连兜底')
  assert.deepEqual(electronDownloadUrls(version, file, 'direct'), [url])
})

test('下载到文件：逐个块回报进度，sha256 对不上就拒绝并删掉半成品', async () => {
  const root = tempRoot()
  const body = Buffer.from('x'.repeat(200 * 1024))
  const server = await serve(body)
  try {
    const good = join(root, 'good.zip')
    const progress = []
    const result = await downloadArchive([server.url], good, {
      sha256: sha(body),
      onProgress: ({ done, total }) => progress.push({ done, total }),
    })
    assert.deepEqual(readFileSync(good), body)
    assert.equal(result.bytes, body.length)
    assert.equal(result.sha256, sha(body))
    assert.ok(progress.length >= 2, '开始与每块都要回报进度')
    assert.equal(progress[0].done, 0, '先告诉页面总大小')
    assert.equal(progress.at(-1).done, body.length)

    const bad = join(root, 'bad.zip')
    await assert.rejects(downloadArchive([server.url], bad, { sha256: sha('other') }), /sha256 对不上/)
    assert.equal(existsSync(bad), false, '校验失败不能留下半成品')
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('取消：已经中止的信号不再发请求，错误认得出来', async () => {
  const root = tempRoot()
  const server = await serve('data')
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(downloadArchive([server.url], join(root, 'x.zip'), { signal: controller.signal }), (error) => isAbortError(error))
    assert.deepEqual(server.requests, [], '中止后不该再发请求')
    assert.equal(isAbortError(abortError()), true)
    assert.equal(isAbortError(new Error('boom')), false)
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('解压保留目录结构（mac 用 ditto、Windows 用系统 tar）', { skip: !SYSTEM_EXTRACT && '没有对应的系统解压工具' }, async () => {
  const root = tempRoot()
  try {
    const zipPath = join(root, 'app.zip')
    writeFileSync(zipPath, writeZip([
      { name: 'a/b.txt', data: 'hello\n' },
      { name: 'top.txt', data: 'top\n' },
    ]))
    const dest = join(root, 'out')
    await extractArchive(zipPath, dest, { platform: process.platform })
    assert.equal(readFileSync(join(dest, 'a', 'b.txt'), 'utf8'), 'hello\n')
    assert.equal(readFileSync(join(dest, 'top.txt'), 'utf8'), 'top\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 造一份「Electron 发行包」zip：mac 是 .app 里的可执行文件，Windows 是 electron.exe。 */
function electronZip(platform) {
  return writeZip(platform === 'darwin'
    ? [{ name: 'Electron.app/Contents/MacOS/Electron', data: 'binary' }, { name: 'LICENSE', data: 'MIT' }]
    : [{ name: 'electron.exe', data: 'MZ' }, { name: 'resources/default_app.asar', data: 'asar' }])
}

function installPlatform() {
  const platform = process.platform
  const arch = Object.keys(RUNTIME_VERSIONS.electron).find((key) => key.startsWith(`${platform}-`))?.split('-')[1]
  return { platform, arch }
}

test('安装运行时：假下载喂真解压 → 整体换名写 .ready；再次调用直接复用', { skip: !SYSTEM_EXTRACT && '没有对应的系统解压工具' }, async () => {
  const root = tempRoot()
  try {
    const { platform, arch } = installPlatform()
    assert.ok(arch, 'runtime-versions.json 里要有当前平台的包')
    const appDir = join(root, 'appdata')
    const zip = electronZip(platform)
    let downloads = 0
    const download = async (urls, file, options) => {
      downloads += 1
      assert.ok(urls.at(-1).startsWith('https://github.com/electron/electron/releases/download/'), '直连兜底的是官方发行包')
      writeFileSync(file, zip)
      options.onProgress?.({ done: zip.length, total: zip.length })
      return { bytes: zip.length, sha256: sha(zip) }
    }
    const first = await installElectronRuntime({ appDir, platform, arch, version: RUNTIME_VERSIONS.electron.version, download })
    assert.equal(first.installed, true)
    assert.equal(first.reused, false)
    const versionDir = join(appDir, 'runtime', 'electron', RUNTIME_VERSIONS.electron.version)
    assert.ok(existsSync(join(versionDir, '.ready')), '.ready 是外壳认「装好了」的唯一标记')
    assert.ok(existsSync(first.dir), '安装目录最后一步是整体改名，失败不会留下半成品')

    const second = await installElectronRuntime({ appDir, platform, arch, version: RUNTIME_VERSIONS.electron.version, download })
    assert.equal(second.reused, true)
    assert.equal(downloads, 1, '已装好就不要再下载一遍')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('安装失败：清理暂存目录，不留下能被当成运行时的半成品', { skip: !SYSTEM_EXTRACT && '没有对应的系统解压工具' }, async () => {
  const root = tempRoot()
  try {
    const { platform, arch } = installPlatform()
    assert.ok(arch)
    const appDir = join(root, 'appdata')
    // 包里没有 Electron 可执行文件：解压能过，自检要拦下来
    const zip = writeZip([{ name: 'unrelated.txt', data: 'oops' }])
    const download = async (urls, file) => {
      writeFileSync(file, zip)
      return { bytes: zip.length, sha256: sha(zip) }
    }
    await assert.rejects(
      installElectronRuntime({ appDir, platform, arch, version: RUNTIME_VERSIONS.electron.version, download }),
      /没有 Electron 可执行文件/,
    )
    const parent = join(appDir, 'runtime', 'electron')
    const left = existsSync(parent) ? readdirSync(parent) : []
    assert.ok(!left.some((name) => name.startsWith('.tmp-')), `暂存目录要清掉：${left.join(', ')}`)
    assert.equal(existsSync(join(parent, RUNTIME_VERSIONS.electron.version)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('取消正在进行的运行时安装：把取消原样抛给页面，暂存目录也清掉', { skip: !SYSTEM_EXTRACT && '没有对应的系统解压工具' }, async () => {
  const root = tempRoot()
  try {
    const { platform, arch } = installPlatform()
    assert.ok(arch)
    const appDir = join(root, 'appdata')
    const download = async () => { throw abortError() }
    await assert.rejects(
      installElectronRuntime({ appDir, platform, arch, version: RUNTIME_VERSIONS.electron.version, download }),
      (error) => isAbortError(error) && error.message.includes('取消'),
    )
    const parent = join(appDir, 'runtime', 'electron')
    const left = existsSync(parent) ? readdirSync(parent) : []
    assert.deepEqual(left.filter((name) => name.startsWith('.tmp-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没收录的平台架构：直接说明不支持，不硬下错包', async () => {
  const root = tempRoot()
  try {
    await assert.rejects(
      installElectronRuntime({ appDir: join(root, 'appdata'), platform: 'linux', arch: 'x64', version: RUNTIME_VERSIONS.electron.version }),
      /没有 linux-x64 的 Electron 运行时压缩包/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
