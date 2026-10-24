import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { netFetch } from './proxy.js'
import { cmpVer, parseVer } from './version.js'

/**
 * 可选的 Electron 外壳：安装包里不带，用户要用标签页时现场下一个。
 *
 * 为什么不随包发：一份 Electron 解压完 200 MB 上下，而绝大多数用户只用浏览器打开 dsh。
 * 把它做成「运行时按需下载」，安装包还是十几 MB，想要的人点一下就有。
 *
 * 版本策略：默认下最新 release，之后每次查到更新就在设置页提示，用户点一下更新到最新。
 * 不钉版本——我们只用 BrowserWindow / WebContentsView 这些十年没变的 API，跟着最新走
 * 反而省得哪天旧版本的二进制从镜像上消失。
 */

/** 镜像优先还是官方优先，跟设置页那个「下载源」用同一个值（mirror / official）。 */
const MIRROR = 'https://npmmirror.com/mirrors/electron'
const OFFICIAL = 'https://github.com/electron/electron/releases/download'
/** 查最新版走 npm registry：一个几 KB 的 JSON，比 GitHub 的 API 稳得多，也不限流。 */
const LATEST_ENDPOINTS = {
  mirror: ['https://registry.npmmirror.com/electron/latest', 'https://registry.npmjs.org/electron/latest'],
  official: ['https://registry.npmjs.org/electron/latest', 'https://registry.npmmirror.com/electron/latest'],
}
/** 小于这个大小的「zip」一定是错误页或者半截文件，不值得再去算 sha256。 */
const MIN_ZIP_BYTES = 20 * 1024 * 1024

/** 官方发行包的文件名，平台和架构的写法跟 process.platform / process.arch 一致。 */
export function electronAssetName(version, platform = process.platform, arch = process.arch) {
  return `electron-v${version}-${platform}-${arch}.zip`
}

/** 下载地址的候选列表：选中的源排第一，另一个兜底——镜像缺包和 GitHub 连不上都遇得到。 */
export function electronUrls(version, { platform = process.platform, arch = process.arch, source = 'mirror' } = {}) {
  const asset = electronAssetName(version, platform, arch)
  const mirror = `${MIRROR}/${version}/${asset}`
  const official = `${OFFICIAL}/v${version}/${asset}`
  return source === 'official' ? [official, mirror] : [mirror, official]
}

/** 校验和清单的地址，顺序和下载地址一致。 */
export function shasumUrls(version, { source = 'mirror' } = {}) {
  const mirror = `${MIRROR}/${version}/SHASUMS256.txt`
  const official = `${OFFICIAL}/v${version}/SHASUMS256.txt`
  return source === 'official' ? [official, mirror] : [mirror, official]
}

/** 从 SHASUMS256.txt 里挑出这个文件的 sha256（格式是 `<sha> *<文件名>`）。 */
export function parseShasums(text, asset) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+\*?/)
    if (name === asset && /^[0-9a-f]{64}$/i.test(sha || '')) return sha.toLowerCase()
  }
  return ''
}

/** 装好的版本放在数据目录的 runtimes/electron/<版本>/，和 versions/ 平级。 */
export function electronRoot(dataDir) {
  return join(dataDir, 'runtimes', 'electron')
}

/**
 * 已经装好的版本（目录名就是版本号）。装到一半的目录带 .tmp- 后缀，不算数。
 * 正常只会有一个；真留下多个就用最新的那个，另一个等卸载/更新时一起清掉。
 */
export function installedElectronVersions(dataDir, readdir = readdirSync) {
  let names = []
  try {
    names = readdir(electronRoot(dataDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.includes('.tmp-'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  // 新的排前面：cmpVer 收的是 parseVer 的结果，不是版本字符串
  return names.filter((name) => parseVer(name)).sort((a, b) => cmpVer(parseVer(b), parseVer(a)))
}

/** 当前这台机器上该用哪一份：最新的那个已装版本。 */
export function currentElectron(dataDir, readdir = readdirSync) {
  return installedElectronVersions(dataDir, readdir)[0] || ''
}

/** 装好的版本和最新版比一比；查不到最新版时不要谎报「已是最新」。 */
export function electronStatus(installed, latest) {
  const current = parseVer(installed || '')
  const newest = parseVer(latest || '')
  return {
    installed: installed || '',
    latest: latest || '',
    outdated: Boolean(current && newest && cmpVer(current, newest) < 0),
  }
}

/** 依次试几个地址，第一个成功的算数；全失败就把最后一个错误抛出去。 */
async function firstOk(urls, fetchImpl, init = {}) {
  let last = null
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { res, url }
    } catch (error) {
      last = error
    }
  }
  throw last || new Error('没有可用的下载地址')
}

/** 查最新的 Electron 版本号。 */
export async function latestElectronVersion({ source = 'mirror', fetchImpl = netFetch } = {}) {
  const { res } = await firstOk(LATEST_ENDPOINTS[source] || LATEST_ENDPOINTS.mirror, fetchImpl, {
    signal: AbortSignal.timeout(30_000),
  })
  const meta = await res.json()
  const version = String(meta?.version || '').trim()
  if (!parseVer(version)) throw new Error('没拿到 Electron 的版本号')
  return version
}

/**
 * 下载并安装一个版本，返回装好的目录。
 *
 * - 先解压到 `<版本>.tmp-<pid>` 再改名：中途断网 / 关机都不会留下一个「看着装好了」的半成品。
 * - 解压交给 fileManager：mac 的 Electron.app 里有符号链接和可执行位，必须用 ditto 这类
 *   系统工具，自己写的 zip 读取器还原不出来。
 */
export async function installElectron({
  version,
  dataDir,
  source = 'mirror',
  platform = process.platform,
  arch = process.arch,
  fetchImpl = netFetch,
  extract,
  onProgress = () => {},
}) {
  if (!parseVer(version)) throw new Error(`版本号不对：${version}`)
  if (typeof extract !== 'function') throw new Error('缺少解压实现')
  const asset = electronAssetName(version, platform, arch)
  const root = electronRoot(dataDir)
  const target = join(root, version)
  const staging = `${target}.tmp-${process.pid}`
  const archive = join(root, `${asset}.part-${process.pid}`)
  await mkdir(root, { recursive: true })

  // 校验和先拿：下完 200 MB 才发现镜像上没有清单就太晚了
  onProgress({ phase: 'prepare', version })
  let expected = ''
  try {
    const { res } = await firstOk(shasumUrls(version, { source }), fetchImpl, { signal: AbortSignal.timeout(60_000) })
    expected = parseShasums(await res.text(), asset)
  } catch {
    // 镜像偶尔不放清单：不拦着装，但下面的日志会说清楚这次没校验
  }

  onProgress({ phase: 'download', version, done: 0, total: 0 })
  const { res, url } = await firstOk(electronUrls(version, { platform, arch, source }), fetchImpl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  })
  const total = Number(res.headers.get('content-length') || 0)
  const hash = createHash('sha256')
  const chunks = []
  let done = 0
  for await (const chunk of res.body) {
    chunks.push(chunk)
    hash.update(chunk)
    done += chunk.length
    onProgress({ phase: 'download', version, done, total })
  }
  const buffer = Buffer.concat(chunks)
  if (buffer.length < MIN_ZIP_BYTES) throw new Error(`下载到的不是 Electron 发行包（${buffer.length} 字节，多半是错误页）`)
  const actual = hash.digest('hex')
  if (expected && actual !== expected) throw new Error('校验没过：下载到的文件和官方校验和对不上，请重试或换下载源')

  try {
    await writeFile(archive, buffer)
    onProgress({ phase: 'extract', version })
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await extract(archive, staging)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
  onProgress({ phase: 'done', version })
  return { dir: target, version, url, verified: Boolean(expected) }
}

/** 卸载：把整个 runtimes/electron 删掉（包括可能残留的半成品目录）。 */
export async function uninstallElectron(dataDir) {
  const root = electronRoot(dataDir)
  if (!existsSync(root)) return false
  await rm(root, { recursive: true, force: true })
  return true
}
