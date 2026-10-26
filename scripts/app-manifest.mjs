// 应用层增量更新：给打包后的 resources/app 生成文件清单、整包 zip 与签名。
//
//   node scripts/app-manifest.mjs build --app <app目录> --version <启动器版本> --electron <Electron版本> [--out release]
//   node scripts/app-manifest.mjs verify --manifest <清单> --zip <zip> [--sig <签名>]
//
// 清单只写事实（每个文件的路径/大小/sha256、版本、Electron 版本），由客户端用内置公钥
// 校验签名后再按哈希对比本地文件，决定要不要下载整包。签名复用 release-manifest.mjs。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readZipEntry, readZipIndex, writeZip } from '../zipfile.js'
import { PRIVATE_KEY, PUBLIC_KEY, signBytes, verifySignature } from './release-manifest.mjs'

export const APP_SCHEMA = 'dsh-x.app/v1'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 递归列出目录里的文件（相对路径统一用 /，排序保证清单稳定）。 */
export function listFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push(relative(dir, path).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

export function buildAppManifest(appDir, { version, electronVersion, platform, archive } = {}) {
  const files = listFiles(appDir).map((path) => {
    const stat = statSync(join(appDir, path))
    return { path, size: stat.size, sha256: hashFile(join(appDir, path)) }
  })
  return {
    schema: APP_SCHEMA,
    version: String(version || ''),
    electronVersion: String(electronVersion || ''),
    platform: String(platform || ''),
    builtAt: new Date().toISOString(),
    ...(archive ? { archive } : {}),
    files,
  }
}

/** 把 app 目录打成整包 zip（文件相对 app 根，客户端解压后按清单逐个校验）。 */
export async function buildAppZip(appDir, target) {
  const entries = listFiles(appDir).map((path) => ({ name: path, file: join(appDir, path) }))
  await writeZip(target, entries)
  return { size: statSync(target).size, sha256: hashFile(target) }
}

/** 校验清单签名（可选）与 zip 里每个文件的大小/哈希；返回清单对象。 */
export async function verifyAppArchive({ manifestPath, zipPath, sigPath, publicKeyPem } = {}) {
  const bytes = readFileSync(manifestPath)
  if (sigPath) {
    const key = publicKeyPem || readFileSync(PUBLIC_KEY, 'utf8')
    if (!verifySignature(bytes, readFileSync(sigPath, 'utf8'), key)) {
      throw new Error('清单签名校验失败')
    }
  }
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (manifest.schema !== APP_SCHEMA) throw new Error(`清单格式不认识：${manifest.schema}`)
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('清单里没有文件')
  if (zipPath) {
    const { entries } = await readZipIndex(zipPath)
    for (const file of manifest.files) {
      const entry = entries.get(file.path)
      if (!entry) throw new Error(`zip 里缺少 ${file.path}`)
      const data = await readZipEntry(zipPath, entry)
      if (data.length !== file.size || createHash('sha256').update(data).digest('hex') !== file.sha256) {
        throw new Error(`zip 里的 ${file.path} 与清单不一致`)
      }
    }
  }
  return manifest
}

/** 生成资产：zip 先落盘，再把 archive 信息写进清单并签名。 */
export async function buildAppAssets({ appDir, version, electronVersion, platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform, outDir = join(ROOT, 'release'), privateKeyPem = process.env.DSH_RELEASE_KEY } = {}) {
  const base = `app-${version}-${platform}`
  const zipPath = join(outDir, `${base}.zip`)
  const archive = await buildAppZip(appDir, zipPath)
  const manifest = buildAppManifest(appDir, { version, electronVersion, platform, archive: { name: `${base}.zip`, ...archive } })
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestPath = join(outDir, `${base}.manifest.json`)
  writeFileSync(manifestPath, bytes)
  let sigPath = ''
  let key = privateKeyPem
  if (!key && existsSync(PRIVATE_KEY)) key = readFileSync(PRIVATE_KEY, 'utf8')
  if (key) {
    sigPath = `${manifestPath}.sig`
    writeFileSync(sigPath, `${signBytes(bytes, key)}\n`)
  }
  return { zipPath, manifestPath, sigPath, manifest }
}

function argValue(argv, name, fallback = '') {
  const index = argv.indexOf(name)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2)
  if (command === 'build') {
    const appDir = resolve(argValue(process.argv, '--app', join(ROOT, 'release', 'DSH', 'resources', 'app')))
    const version = argValue(process.argv, '--version')
    const electronVersion = argValue(process.argv, '--electron')
    const platform = argValue(process.argv, '--platform')
    const outDir = resolve(argValue(process.argv, '--out', join(ROOT, 'release')))
    if (!version) throw new Error('缺少 --version')
    if (!existsSync(appDir)) throw new Error(`找不到 app 目录：${appDir}`)
    const result = await buildAppAssets({ appDir, version, electronVersion, ...(platform ? { platform } : {}), outDir })
    console.log(`应用清单：${result.manifestPath}（${result.manifest.files.length} 个文件）`)
    console.log(`应用整包：${result.zipPath}（${(result.manifest.archive.size / 1048576).toFixed(1)} MB）`)
    console.log(result.sigPath ? `签名：${result.sigPath}` : '未签名：没有 release/release-key.pem 或 DSH_RELEASE_KEY，本次不提供增量更新')
  } else if (command === 'verify') {
    const manifest = await verifyAppArchive({
      manifestPath: resolve(argValue(process.argv, '--manifest')),
      zipPath: resolve(argValue(process.argv, '--zip')),
      sigPath: argValue(process.argv, '--sig') ? resolve(argValue(process.argv, '--sig')) : '',
    })
    console.log(`清单与 zip 校验通过：${manifest.version}（${manifest.files.length} 个文件，Electron ${manifest.electronVersion}）`)
  } else {
    console.log('用法: node scripts/app-manifest.mjs <build|verify> [--app <dir>] [--version <ver>] [--electron <ver>] [--out <dir>] [--manifest <file>] [--zip <file>] [--sig <file>]')
    process.exitCode = 1
  }
}
