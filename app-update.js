// 应用层增量更新（客户端侧）：拉清单、验签、对比本地文件、下载与暂存。
//
// 思路：发布时给 resources/app 生成「路径 + 大小 + sha256」清单并用发布私钥签名；客户端
// 用内置公钥校验清单，按哈希找出变化的文件，下载整包（app-<版本>-win.zip）解到临时目录
// 逐个校验，退出后由 apply-update.mjs 换目录。Electron 版本变了就不能用增量，走全量安装包。

import { createHash, verify as cryptoVerify } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { readZipEntry, readZipIndex } from './zipfile.js'

export const APP_SCHEMA = 'dsh-x.app/v1'

/**
 * 客户端内置公钥：与仓库里的 scripts/release-pubkey.pem 是同一把（Ed25519）。
 * 应用清单必须用对应私钥签名，否则不提供增量更新。
 */
export const APP_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMLWjUtLegI3HpVQliKDRmMtEYfbzb66rIPgOTxdcTsg=
-----END PUBLIC KEY-----`

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function verifyAppManifest(bytes, signatureBase64, publicKeyPem = APP_PUBLIC_KEY) {
  try {
    return cryptoVerify(null, bytes, publicKeyPem, Buffer.from(String(signatureBase64).trim(), 'base64'))
  } catch {
    return false
  }
}

/** 某个版本在发布页上的资产名（Windows 与 mac 分开命名，互不覆盖）。 */
export function appAssetName(version, platform, ext) {
  return `app-${version}-${platform}${ext}`
}

export function appAssetUrl(repo, version, platform, ext) {
  return `https://github.com/${repo}/releases/download/v${version}/${appAssetName(version, platform, ext)}`
}

/**
 * 本地文件与清单的差异：只报「缺失或哈希不同」的文件；清单外的文件不碰
 * （安装目录里可能有 data/ 这类运行时目录，删了会丢数据）。
 */
export function localDiff(appDir, manifest) {
  const changed = []
  let changedBytes = 0
  for (const file of manifest.files || []) {
    const target = join(appDir, ...String(file.path).split('/'))
    let same = false
    try {
      if (statSync(target).size === file.size) same = hashFile(target) === file.sha256
    } catch { /* 缺失按变化处理 */ }
    if (!same) {
      changed.push(file)
      changedBytes += file.size
    }
  }
  return { changed: changed.length, changedBytes, files: changed }
}

/** 校验清单内容的基本形状；不合法就整份拒绝。 */
export function assertManifestShape(manifest, { version, electronVersion, platform }) {
  if (!manifest || manifest.schema !== APP_SCHEMA) throw new Error('应用清单格式不认识')
  if (String(manifest.version) !== String(version)) throw new Error('应用清单的版本与发布版本不一致')
  if (String(manifest.platform) !== String(platform)) throw new Error('应用清单的平台不一致')
  if (String(manifest.electronVersion) !== String(electronVersion)) {
    const error = new Error('Electron 版本不同，需要完整安装包')
    error.code = 'electron_mismatch'
    throw error
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('应用清单里没有文件')
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      throw new Error(`应用清单里有非法路径：${file.path}`)
    }
    if (!Number.isFinite(file.size) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`应用清单里的 ${file.path} 缺少有效的大小/哈希`)
    }
  }
  return manifest
}

/**
 * 把 zip 解到暂存目录，逐个对照清单校验大小与 sha256。
 * 只落清单里列出的文件（清单外的条目一律不写）。
 */
export async function extractVerified(zipPath, manifest, stagingDir, onProgress) {
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })
  const { entries } = await readZipIndex(zipPath)
  const files = manifest.files
  let done = 0
  for (const file of files) {
    const entry = entries.get(file.path)
    if (!entry) throw new Error(`安装包缺少 ${file.path}`)
    const data = await readZipEntry(zipPath, entry)
    if (data.length !== file.size) throw new Error(`${file.path} 的大小与清单不一致`)
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`${file.path} 的哈希与清单不一致`)
    const target = join(stagingDir, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    done += 1
    if (onProgress) onProgress(done, files.length)
  }
  return stagingDir
}

/** 暂存目录里的文件数与体积（应用前核对，避免空目录被当成新版本）。 */
export function stagingStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(path).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

export function stagingExists(dir) {
  return Boolean(dir) && existsSync(join(dir, 'server.js'))
}
