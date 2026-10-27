// SBOM：用 SPDX 2.3 列出「安装包里到底带了什么」，随发布资产一起发出。
//
//   node scripts/release-sbom.mjs          生成 release/dsh-x-<版本>.spdx.json
//
// 尺度说明：安装包里**没有 Node / Electron 运行时**——Node 由原生外壳首次运行时下载到数据
// 目录，Electron 由服务按需下载；两者都不属于这个安装包，不在这里声明。随包发的第三方只有
// npm / pnpm 的 JS 包（app/node/node_modules 下，按「整包一个条目」声明版本与许可证，不逐层
// 展开它们内部的 node_modules）。启动器自己随包发的文件（含 Rust 外壳二进制）逐个列入并带
// sha256，方便核对。这不是法律意义上的完整 SBOM，而是「这个安装包里有什么、能对上哈希」的
// 可核验清单。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO = 'yyh-001/DSH-X'

/**
 * 随包发的第三方运行时 JS 包：nodeDir 下的相对目录 → SPDX 条目信息。
 * 只有 JS 包，没有可执行文件：Node 本体不在安装包里（下载的运行时含 npm，
 * 但 registry.js 需要安装目录里就有一份 npm 可读，pnpm 则是因为 dsh plugin 依赖它）。
 */
const RUNTIMES = [
  { key: 'npm', dir: 'node_modules/npm', name: 'npm', homepage: 'https://github.com/npm/cli', license: 'Artistic-2.0' },
  { key: 'pnpm', dir: 'node_modules/pnpm', name: 'pnpm', homepage: 'https://pnpm.io', license: 'MIT' },
]

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 版本直接读包自带的 package.json：npm / pnpm 都是纯 JS 包，版本号就写在里面。 */
function runtimeVersion(nodeDir, entry) {
  const manifest = readJson(join(nodeDir, entry.dir, 'package.json'))
  return manifest?.version ?? null
}

export function collectComponents({ nodeDir } = {}) {
  const components = {}
  if (!nodeDir || !existsSync(nodeDir)) return components
  for (const entry of RUNTIMES) {
    const version = runtimeVersion(nodeDir, entry)
    if (version) components[entry.key] = version
  }
  return components
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 随包发的文件：release/DSH 下除 npm / pnpm 的 JS 包（按组件条目声明）以外的所有文件。
 * 新布局里它们在 resources/app/node/（跟着 app 层走）；旧包还有安装根下的 node/（Electron
 * 时代），一并跳过，免得同一份 SBOM 生成器对旧产物列出上万条文件。
 */
export function collectShippedFiles(dshDir) {
  const out = []
  const skipDirs = new Set(['node', 'resources/app/node'])
  const walk = (dir, prefix) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (skipDirs.has(rel)) continue
        walk(join(dir, item.name), rel)
      } else {
        out.push(rel)
      }
    }
  }
  if (existsSync(dshDir)) walk(dshDir, '')
  return out.sort()
}

/** npm / pnpm 的 JS 包在 app 层（resources/app/node），不在安装根上。 */
function componentsDir(dshDir) {
  return join(dshDir, 'resources', 'app', 'node')
}

function spdxId(kind, name) {
  return `SPDXRef-${kind}-${String(name).replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-|-$/g, '')}`
}

export function buildSbom({ version, commit, builtAt, components = {}, files = [], extras = [], releaseDir, dshDir }) {
  const namespace = `https://github.com/${REPO}/spdx/${version}-${String(commit ?? 'nogit').slice(0, 8)}-${builtAt.replace(/[^0-9]/g, '').slice(0, 14)}`
  const appId = spdxId('Package', 'dsh-x')
  const packages = [
    {
      SPDXID: appId,
      name: 'DSH-X',
      versionInfo: version,
      downloadLocation: `https://github.com/${REPO}/releases/tag/v${version}`,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'MIT',
      copyrightText: 'NOASSERTION',
      externalRefs: [
        { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:github/${REPO}@v${version}` },
      ],
    },
  ]
  const relationships = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: appId }]

  for (const entry of RUNTIMES) {
    const ver = components[entry.key]
    if (!ver) continue
    const id = spdxId('Package', entry.name)
    packages.push({
      SPDXID: id,
      name: entry.name,
      versionInfo: ver,
      downloadLocation: entry.homepage,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: entry.license,
      copyrightText: 'NOASSERTION',
    })
    relationships.push({ spdxElementId: appId, relationshipType: 'CONTAINS', relatedSpdxElement: id })
  }

  const filesOut = []
  const addFile = (label, file, comment) => {
    const id = spdxId('File', label)
    filesOut.push({
      SPDXID: id,
      fileName: `./${label}`,
      checksums: [{ algorithm: 'SHA256', checksumValue: hashFile(file) }],
      licenseConcluded: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      ...(comment ? { comment } : {}),
    })
    relationships.push({ spdxElementId: appId, relationshipType: 'CONTAINS', relatedSpdxElement: id })
  }

  for (const name of extras) addFile(name, join(releaseDir, name), '发布资产（安装包）')
  for (const name of files) addFile(`DSH/${name}`, join(dshDir, name), '安装到用户机器上的文件')

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `DSH-X-${version}`,
    documentNamespace: namespace,
    documentComment: '第三方运行时（npm / pnpm 的 JS 包）按整包声明，未展开其内部依赖；Node 与 Electron 不随安装包发（分别在首次运行、选择内部标签页时下载到数据目录），故不在此声明；启动器自身随包文件逐个列出并带 sha256。',
    creationInfo: {
      created: builtAt,
      creators: ['Tool: dsh-x release-sbom (scripts/release-sbom.mjs)'],
    },
    packages,
    files: filesOut,
    relationships,
  }
}

export function writeSbom({ releaseDir = join(ROOT, 'release'), version, commit, now = new Date() } = {}) {
  const dshDir = join(releaseDir, 'DSH')
  const sbom = buildSbom({
    version,
    commit,
    builtAt: now.toISOString(),
    components: collectComponents({ nodeDir: componentsDir(dshDir) }),
    files: collectShippedFiles(dshDir),
    extras: ['DSH-Setup.exe'].filter((name) => existsSync(join(releaseDir, name))),
    releaseDir,
    dshDir,
  })
  mkdirSync(releaseDir, { recursive: true })
  const out = join(releaseDir, `dsh-x-${version}.spdx.json`)
  writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`)
  return { sbom, path: out }
}

function main() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const { sbom, path } = writeSbom({ version })
  const counts = { 包: sbom.packages.length, 文件: sbom.files.length, 关系: sbom.relationships.length }
  console.log(`SBOM: ${path}`)
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  console.log(`  组件: ${sbom.packages.slice(1).map((p) => `${p.name} ${p.versionInfo}`).join(', ') || '（release/DSH/resources/app/node 里没找到）'}`)
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exit(main())
  } catch (error) {
    console.error(`失败: ${error.message}`)
    process.exit(1)
  }
}
