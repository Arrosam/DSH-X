import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  currentElectron,
  electronAssetName,
  electronRoot,
  electronStatus,
  electronUrls,
  installElectron,
  installedElectronVersions,
  latestElectronVersion,
  parseShasums,
  shasumUrls,
  uninstallElectron,
} from '../electron.js'

/** 真的 Electron 发行包上百 MB，用例里只要过得了「这不是错误页」那道坎就行。 */
const MIN_ZIP_BYTES = 20 * 1024 * 1024
const entries = (names) => names.map((name) => ({ name, isDirectory: () => true }))

function fakeFetch(routes) {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    const answer = routes[url]
    if (!answer) throw new Error(`连不上 ${url}`)
    return {
      ok: answer.status ? answer.status < 400 : true,
      status: answer.status || 200,
      headers: { get: (key) => (key === 'content-length' ? String(answer.body?.length || 0) : null) },
      body: answer.body ? Readable.from([answer.body]) : null,
      json: async () => answer.json,
      text: async () => answer.text,
    }
  }
  return { fetchImpl, seen }
}

test('发行包的文件名和地址：选中的源排第一，另一个兜底', () => {
  assert.equal(electronAssetName('35.1.0', 'darwin', 'arm64'), 'electron-v35.1.0-darwin-arm64.zip')
  assert.equal(electronAssetName('35.1.0', 'win32', 'x64'), 'electron-v35.1.0-win32-x64.zip')

  const [first, second] = electronUrls('35.1.0', { platform: 'win32', arch: 'x64', source: 'mirror' })
  assert.match(first, /npmmirror\.com\/mirrors\/electron\/35\.1\.0\/electron-v35\.1\.0-win32-x64\.zip$/)
  assert.match(second, /github\.com\/electron\/electron\/releases\/download\/v35\.1\.0\//)
  assert.match(electronUrls('35.1.0', { source: 'official' })[0], /github\.com/)
  assert.match(shasumUrls('35.1.0', { source: 'official' })[0], /github\.com.*SHASUMS256\.txt$/)
})

test('校验和清单：只认这个文件那一行，认不出来就当没有', () => {
  const sha = 'a'.repeat(64)
  const text = [`${'b'.repeat(64)} *electron-v35.1.0-win32-x64.zip`, `${sha} *electron-v35.1.0-darwin-arm64.zip`].join('\n')
  assert.equal(parseShasums(text, 'electron-v35.1.0-darwin-arm64.zip'), sha)
  assert.equal(parseShasums(text, 'electron-v35.1.0-linux-x64.zip'), '')
  assert.equal(parseShasums('乱七八糟 *electron-v35.1.0-darwin-arm64.zip', 'electron-v35.1.0-darwin-arm64.zip'), '')
  assert.equal(parseShasums('', 'x.zip'), '')
})

test('已装版本：新的排前面，装一半的目录和不像版本号的都不算', () => {
  const list = () => entries(['34.2.0', '9.0.0', '35.0.0.tmp-7', 'README', '35.1.0'])
  assert.deepEqual(installedElectronVersions('/data', list), ['35.1.0', '34.2.0', '9.0.0'])
  assert.equal(currentElectron('/data', list), '35.1.0')
  assert.equal(currentElectron('/data', () => { throw new Error('ENOENT') }), '', '目录还不存在时就是没装')
})

test('状态：查不到最新版时不谎报「已是最新」', () => {
  assert.deepEqual(electronStatus('34.0.0', '35.1.0'), { installed: '34.0.0', latest: '35.1.0', outdated: true })
  assert.equal(electronStatus('35.1.0', '35.1.0').outdated, false)
  assert.equal(electronStatus('34.0.0', '').outdated, false, '没查到最新版，不能说它过期')
  assert.equal(electronStatus('', '35.1.0').outdated, false, '没装就谈不上过期')
})

test('查最新版：第一个源不通就换下一个，拿到的不是版本号要报错', async () => {
  const good = { 'https://registry.npmjs.org/electron/latest': { json: { version: '35.1.0' } } }
  const { fetchImpl, seen } = fakeFetch(good)
  assert.equal(await latestElectronVersion({ source: 'mirror', fetchImpl }), '35.1.0')
  assert.equal(seen.length, 2, '镜像先试，失败了才轮到官方 registry')

  const junk = fakeFetch({ 'https://registry.npmjs.org/electron/latest': { json: { version: 'latest' } } })
  await assert.rejects(latestElectronVersion({ source: 'official', fetchImpl: junk.fetchImpl }), /版本号/)
})

test('安装：校验通过才落地，装到一半的目录不会被当成装好了', async () => {
  const data = mkdtempSync(join(tmpdir(), 'dsh-electron-'))
  try {
    const zip = Buffer.alloc(MIN_ZIP_BYTES, 7)
    const asset = electronAssetName('35.1.0', 'win32', 'x64')
    const sha = createHash('sha256').update(zip).digest('hex')
    const { fetchImpl } = fakeFetch({
      [`https://npmmirror.com/mirrors/electron/35.1.0/SHASUMS256.txt`]: { text: `${sha} *${asset}` },
      [`https://npmmirror.com/mirrors/electron/35.1.0/${asset}`]: { body: zip },
    })
    const phases = []
    const result = await installElectron({
      version: '35.1.0',
      dataDir: data,
      platform: 'win32',
      arch: 'x64',
      fetchImpl,
      onProgress: (progress) => phases.push(progress.phase),
      // 解压交给 fileManager，用例里换成「把包里的东西写两个文件」
      extract: async (archive, dest) => {
        assert.ok(existsSync(archive), '解压时压缩包应该已经落到磁盘上')
        assert.match(dest, /\.tmp-\d+$/, '先解压到临时目录，成功了才改名')
        await mkdir(join(dest, 'resources'), { recursive: true })
        writeFileSync(join(dest, 'electron.exe'), readFileSync(archive).subarray(0, 4))
      },
    })
    assert.equal(result.version, '35.1.0')
    assert.equal(result.verified, true)
    assert.equal(result.dir, join(electronRoot(data), '35.1.0'))
    assert.ok(existsSync(join(result.dir, 'electron.exe')))
    assert.deepEqual(phases, ['prepare', 'download', 'download', 'extract', 'done'])
    assert.deepEqual(installedElectronVersions(data), ['35.1.0'])
    // 压缩包和临时目录都要收拾干净，不能在数据目录里白占 200 MB
    assert.deepEqual(readdirSync(electronRoot(data)), ['35.1.0'])
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('安装：错误页和对不上的校验和都要拦下来，不留半截目录', async () => {
  const data = mkdtempSync(join(tmpdir(), 'dsh-electron-'))
  try {
    const asset = electronAssetName('35.1.0', 'win32', 'x64')
    const tiny = fakeFetch({
      [`https://npmmirror.com/mirrors/electron/35.1.0/SHASUMS256.txt`]: { text: '' },
      [`https://npmmirror.com/mirrors/electron/35.1.0/${asset}`]: { body: Buffer.from('<html>404</html>') },
    })
    await assert.rejects(installElectron({
      version: '35.1.0', dataDir: data, platform: 'win32', arch: 'x64', fetchImpl: tiny.fetchImpl, extract: async () => {},
    }), /不是 Electron 发行包/)

    const zip = Buffer.alloc(MIN_ZIP_BYTES, 1)
    const wrong = fakeFetch({
      [`https://npmmirror.com/mirrors/electron/35.1.0/SHASUMS256.txt`]: { text: `${'c'.repeat(64)} *${asset}` },
      [`https://npmmirror.com/mirrors/electron/35.1.0/${asset}`]: { body: zip },
    })
    await assert.rejects(installElectron({
      version: '35.1.0', dataDir: data, platform: 'win32', arch: 'x64', fetchImpl: wrong.fetchImpl, extract: async () => {},
    }), /校验没过/)

    assert.deepEqual(installedElectronVersions(data), [], '失败之后不该留下一个「看着装好了」的目录')
    await assert.rejects(installElectron({ version: 'latest', dataDir: data, extract: async () => {} }), /版本号不对/)
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('卸载：整个 runtimes/electron 删掉，没装过也不报错', async () => {
  const data = mkdtempSync(join(tmpdir(), 'dsh-electron-'))
  try {
    assert.equal(await uninstallElectron(data), false)
    await mkdir(join(electronRoot(data), '35.1.0'), { recursive: true })
    assert.equal(await uninstallElectron(data), true)
    assert.ok(!existsSync(electronRoot(data)))
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('外壳只开本机地址：别的一律不碰', async () => {
  // require 的东西不带 electron，所以这份用例不用装 Electron 也能跑
  const { createRequire } = await import('node:module')
  const { isLocalUrl, urlFromArgv, tabKeyFromArgv } = createRequire(import.meta.url)('../electron-shell/url.js')
  for (const url of ['http://127.0.0.1:9716/?token=x', 'http://localhost:3780/', 'https://[::1]:9716/']) {
    assert.ok(isLocalUrl(url), url)
  }
  for (const url of ['https://github.com/yyh-001/DSH-X', 'http://192.168.1.9:9716/', 'file:///etc/passwd', 'data:text/html,x', '', null]) {
    assert.ok(!isLocalUrl(url), String(url))
  }
  // argv[0] 是 Electron 自己，第一个参数是外壳目录，地址在后面
  assert.equal(urlFromArgv(['/path/Electron', '/app/electron-shell', 'http://127.0.0.1:9716/?token=x']), 'http://127.0.0.1:9716/?token=x')
  assert.equal(urlFromArgv(['/path/Electron', '/app/electron-shell']), '', '没给地址就只开窗口')
  assert.equal(urlFromArgv(['/path/Electron', '/app/electron-shell', 'https://example.com']), '', '外部地址不是这个外壳的事')
})

test('标签身份跟着实例走，不跟端口走', async () => {
  const { createRequire } = await import('node:module')
  const { tabKeyFromArgv } = createRequire(import.meta.url)('../electron-shell/url.js')
  const { instanceTarget } = await import('../server.js')
  // dsh 每次重启端口和 token 都会变：按地址认会留下一个死标签再开一个新的，
  // 所以启动器把实例身份用 --tab= 传给外壳，外壳按它认标签。
  const instance = { home: '/Users/a/.dsh', version: '1.0.0', profile: 'web', url: 'http://127.0.0.1:1234/?token=first' }
  const key = instanceTarget(instance).id
  const argv = ['/path/Electron', '/app/electron-shell', 'http://127.0.0.1:1234/?token=first', `--tab=${key}`]
  assert.equal(tabKeyFromArgv(argv), key)
  assert.equal(tabKeyFromArgv(['/path/Electron', '/app/electron-shell', 'http://127.0.0.1:1234/']), '', '没给身份就退回按 origin 认')
  // 换了端口和 token 还是同一个身份
  assert.equal(instanceTarget({ ...instance, url: 'http://127.0.0.1:5678/?token=second' }).id, key)
  assert.ok(!key.includes('token='))
})
