import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { netFetch } from './proxy.js'
import { DEFAULT_UPDATE_SOURCE, updateUrlCandidates } from './settings.js'
import { ELECTRON_VERSION, electronRuntime } from './platform.js'

/**
 * 按需下载 Electron 运行时。
 *
 * 只有用户选了「独立桌面窗口 / 内部标签页」才需要它，所以下载放在服务里而不是外壳里：
 * 这时 Node 已经在跑，代理（proxy.js 的 netFetch）、SSE 进度、取消都是现成的。
 * 下载的是 Electron 官方发行包，不预先改包；装到数据目录 <APP_DIR>/runtime/electron/<版本>/，
 * 写完 `.ready` 才算装好（外壳也按这个标记扫描，见 launcher/runtime.rs）。
 *
 * 运行时不跟 app 层更新一起变：应用层增量更新只换 resources/app，不碰这里；
 * Electron 升级是单独一件事，旧版本目录留着可以回滚。
 */

/** 官方发行包的地址前缀；版本与压缩包名、sha256 都来自 runtime-versions.json。 */
export const ELECTRON_RELEASE_BASE = 'https://github.com/electron/electron/releases/download'
/** 压缩包上限：Electron 各平台包都在 100~250 MB，超过这个数八成是错误页或别的文件。 */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

export function electronReleaseUrl(version, file) {
  return `${ELECTRON_RELEASE_BASE}/v${version}/${file}`
}

/**
 * 待试地址列表：只有 GitHub 地址才套镜像前缀（和 server.js 的 downloadToFile 同一规矩），
 * 本地测试用的 http 地址原样请求。镜像只做转发，内容靠 sha256 兜底。
 */
export function electronDownloadUrls(version, file, source = DEFAULT_UPDATE_SOURCE) {
  const url = electronReleaseUrl(version, file)
  return /^https:\/\/github\.com\//i.test(url) ? updateUrlCandidates(url, source) : [url]
}

/** 取消是用户主动点的，调用方要能认出来，别把它当下载失败写进日志吓人。 */
export function abortError(message = '下载已取消') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error) {
  return error?.name === 'AbortError'
}

/** 把响应流写到文件并逐块算 sha256；返回 { bytes, sha256 }。 */
async function writeHashed(stream, file, { total = 0, sha256 = '', limit = MAX_ARCHIVE_BYTES, signal, onProgress } = {}) {
  const hash = createHash('sha256')
  const out = createWriteStream(file, { flags: 'w' })
  let done = 0
  const closed = new Promise((resolve, reject) => {
    out.once('close', resolve)
    out.once('error', reject)
  })
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      done += chunk.length
      if (done > limit) throw new Error(`文件太大（超过 ${Math.round(limit / 1048576)} MB），已停下`)
      // 边下边算：下完几百 MB 再整份读一遍算哈希，峰值内存和耗时都翻倍
      hash.update(chunk)
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => {
          out.once('drain', resolve)
          out.once('error', reject)
        })
      }
      onProgress?.({ done, total })
    }
    out.end()
    await closed
  } catch (error) {
    out.destroy()
    await closed.catch(() => {})
    throw error
  }
  const got = hash.digest('hex')
  if (sha256 && got !== String(sha256).toLowerCase()) {
    throw new Error(`压缩包 sha256 对不上（期望 ${String(sha256).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`)
  }
  return { bytes: done, sha256: got }
}

/**
 * 下载到文件：按候选顺序「镜像优先、直连兜底」逐个试，每个都要过 sha256
 * （镜像返回错误页之类会被哈希挡下来，然后换下一个地址重试）。
 */
export async function downloadArchive(urls, file, { sha256 = '', limit = MAX_ARCHIVE_BYTES, signal, onProgress, onLog = () => {} } = {}) {
  let last = null
  for (const candidate of urls || []) {
    try {
      signal?.throwIfAborted()
      onLog(`下载 ${candidate}`)
      const res = await netFetch(candidate, { redirect: 'follow', signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      if (total > limit) throw new Error(`文件太大（${Math.round(total / 1048576)} MB，上限 ${Math.round(limit / 1048576)} MB）`)
      // 先告诉页面总大小，进度条才不会一直转圈
      onProgress?.({ done: 0, total })
      const result = await writeHashed(res.body, file, { total, sha256, limit, signal, onProgress })
      return { url: candidate, ...result }
    } catch (error) {
      last = error
      // 用户取消就立刻停，不再换镜像重试
      if (isAbortError(error)) throw error
      try { rmSync(file, { force: true }) } catch { /* 删不掉下次启动再清 */ }
      onLog(`下载失败：${error?.message || error}`)
    }
  }
  // 直连 GitHub 在国内基本拿不到 release 资产；把出路写进错误里，别让用户只看到「下载失败」
  throw new Error(`下载失败：${last?.message || '没有可用的下载地址'}；可以在设置页把「下载源」改成「镜像源」再试`)
}

/** Windows PowerShell 的字符串字面量（单引号里再写单引号表示一个单引号）。 */
function powershellLiteral(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/** 跑一个解压工具；非零退出码、起不来、被取消都 reject。 */
function runTool(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { if (err.length < 4000) err += chunk })
    const onAbort = () => {
      try { child.kill() } catch { /* 已经退了 */ }
      finish(abortError())
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(`解压失败（${command} 退出码 ${code}）${err.trim() ? `：${err.trim()}` : ''}`))
    })
  })
}

/**
 * 解压官方压缩包。
 *
 * 必须保留符号链接与可执行位：macOS 的 Electron.app 里 Framework 目录有大量符号链接，
 * 用只认文件的解压器（zipfile.js）会把它解坏、应用直接起不来。所以走系统工具：
 * macOS 用 ditto（对 .app 最标准，保留权限/链接/扩展属性），Windows 用自带的 bsdtar
 * （Win10 1809 起随系统，Electron 本身也不支持更老的系统），没有 tar 时退回 PowerShell。
 */
export async function extractArchive(archive, dest, { platform = process.platform, signal } = {}) {
  signal?.throwIfAborted()
  mkdirSync(dest, { recursive: true })
  if (platform === 'darwin') {
    await runTool('ditto', ['-x', '-k', archive, dest], { signal })
    return
  }
  try {
    await runTool('tar', ['-xf', archive, '-C', dest], { signal })
  } catch (error) {
    // tar 只在自己都起不来时才换 PowerShell；解压本身失败要原样报，别掩盖真实原因
    if (isAbortError(error) || error?.code !== 'ENOENT') throw error
    const command = `Expand-Archive -LiteralPath ${powershellLiteral(archive)} -DestinationPath ${powershellLiteral(dest)} -Force`
    await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { signal })
  }
}

function removeQuietly(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 下次再清 */ }
}

/**
 * 下载 → 校验 → 解压 → 写 .ready。装好、或者失败都会清理临时文件；
 * 半成品绝不留下 `.ready`，外壳只认这个标记，不会把半截目录当运行时拉起。
 *
 * 返回值给接口用：{ version, dir, installed: true, reused }。已装好时直接复用（reused: true）。
 * `download` 可以替换（测试用假下载喂真实解压），正常路径就是 downloadArchive。
 */
export async function installElectronRuntime({
  appDir,
  version = ELECTRON_VERSION,
  platform = process.platform,
  arch = process.arch,
  source = DEFAULT_UPDATE_SOURCE,
  signal,
  onProgress,
  onLog = () => {},
  download = downloadArchive,
} = {}) {
  if (!appDir) throw new Error('缺少数据目录')
  const runtime = electronRuntime(appDir, { version, platform, arch })
  if (runtime.installed) return { version, dir: runtime.dir, installed: true, reused: true }
  if (!runtime.download) {
    throw new Error(`没有 ${platform}-${arch} 的 Electron 运行时压缩包，这个平台暂不支持内部窗口`)
  }
  const id = `${process.pid}-${randomBytes(4).toString('hex')}`
  const archive = join(tmpdir(), `DSH-X-electron-${version}-${id}.zip`)
  const parent = join(String(appDir), 'runtime', 'electron')
  mkdirSync(parent, { recursive: true })
  const staging = join(parent, `.tmp-${version}-${id}`)
  try {
    const result = await download(electronDownloadUrls(version, runtime.download.file, source), archive, {
      sha256: runtime.download.sha256,
      signal,
      onProgress,
      onLog,
    })
    signal?.throwIfAborted()
    onLog(`解压 Electron ${version}（${(result.bytes / 1048576).toFixed(1)} MB）`)
    await extractArchive(archive, staging, { platform, signal })
    signal?.throwIfAborted()
    // 自检要看暂存目录里的那份（装好之前还不在 <版本>/ 下）
    if (!existsSync(join(staging, relative(runtime.dir, runtime.executable)))) throw new Error('解压后的目录里没有 Electron 可执行文件')
    // .ready 最后写：外壳看到它时，目录里的东西一定已经完整
    writeFileSync(join(staging, '.ready'), `${JSON.stringify({ version, platform, arch, installedAt: new Date().toISOString() }, null, 2)}\n`)
    // 之前失败的半成品目录（没有 .ready）先清掉，再整体换名；正常安装里的旧版本目录不动
    if (existsSync(runtime.dir)) removeQuietly(runtime.dir)
    renameSync(staging, runtime.dir)
    return { version, dir: runtime.dir, installed: true, reused: false, bytes: result.bytes }
  } catch (error) {
    removeQuietly(staging)
    throw error
  } finally {
    try { await rm(archive, { force: true }) } catch { /* 临时文件，下次启动会清 */ }
  }
}
