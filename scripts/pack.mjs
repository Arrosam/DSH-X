import { existsSync, readFileSync, rmSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { LAUNCHER_NAME } from '../platform.js'
import {
  PKG,
  ROOT,
  VENDOR,
  buildShellBinary,
  cargoExecutable,
  copyAppFiles,
  copyNpmModules,
  copyPnpm as copyPnpmModule,
  download,
  downloadNodeFile,
  nodeArchiveFile,
  run,
} from './pack-common.mjs'
import { collectArtifacts, writeReleaseManifest } from './release-manifest.mjs'
import { collectComponents, writeSbom } from './release-sbom.mjs'

// Windows 和 macOS 各有一套打包脚本；这里负责 Windows 的包 + Inno 安装包，macOS 转给 pack-mac.mjs。
if (process.platform === 'darwin') {
  await import('./pack-mac.mjs')
  process.exit(0)
}

const NODE_ZIP = nodeArchiveFile('win32-x64')
const DIST = NODE_ZIP.replace(/\.zip$/, '')
const ZIP_PATH = join(VENDOR, NODE_ZIP)
const EXTRACTED = join(VENDOR, DIST)
/** 安装目录（Inno 的 {app}）：DSH.exe + resources/app/ 里的启动器代码。 */
const OUT = join(ROOT, 'release', 'DSH')
const APP = join(OUT, 'resources', 'app')
const INNO_DIR = join(VENDOR, 'inno')
const INNO_SETUP = join(VENDOR, 'innosetup.exe')
const ISCC = join(INNO_DIR, 'ISCC.exe')
const SETUP_ISS = join(ROOT, 'scripts', 'dsh-setup.iss')
const SETUP_NAME = 'DSH-Setup'
// Windows 按路径缓存快捷方式图标：同名文件覆盖后，Explorer 仍会显示缓存里的旧位图，
// 升级用户会以为图标没更新。图标文件名带上版本号，路径一变缓存就失效，不用指望用户
// 去清图标缓存。
const ICON_NAME = `dsh-${PKG.version}.ico`
const DESKTOP = join(process.env.USERPROFILE || ROOT, 'Desktop')

/** 打包时下载一份 Node 发行包，只为抄出 npm / pnpm 的 JS 包；node.exe 不进安装包。 */
async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'node_modules', 'npm'))) return
  await downloadNodeFile(NODE_ZIP, ZIP_PATH)
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${ZIP_PATH}' '${VENDOR}'`])
}

/**
 * 自带运行时目录（resources/app/node）。现在这里**没有 node.exe**：Node 由外壳首次运行时
 * 下载到数据目录（安装目录不一定可写，签名也不能碰）。目录里留下 npm / pnpm 的 JS 包和
 * 命令行包装，启动器把它们加进子进程 PATH；包装脚本调用 PATH 上的 `node`，也就是
 * 外壳下载的那份运行时，而不是包里某个固定路径。
 */
async function copyNodeRuntime(nodeDir) {
  await mkdir(nodeDir, { recursive: true })
  await copyNpmModules(join(EXTRACTED, 'node_modules'), nodeDir)
  await copyPnpm(nodeDir, join(EXTRACTED, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  for (const [name, cli] of Object.entries({
    npm: 'npm\\bin\\npm-cli.js',
    npx: 'npm\\bin\\npx-cli.js',
    pnpm: 'pnpm\\bin\\pnpm.cjs',
    pnpx: 'pnpm\\bin\\pnpx.cjs',
  })) {
    await writeFile(join(nodeDir, `${name}.cmd`), [
      '@ECHO off',
      'SETLOCAL',
      `node "%~dp0node_modules\\${cli}" %*`,
      '',
    ].join('\r\n'))
  }
  // git-bash / MSYS 里也有人直接敲 pnpm；和 .cmd 同样转给 PATH 上的 node
  await writeFile(join(nodeDir, 'pnpm'), [
    '#!/bin/sh',
    'exec node "$(dirname "$0")/node_modules/pnpm/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'))
}

/** 安装目录组装：原生外壳 DSH.exe + 平铺的 app 层，没有 Electron 框架。 */
async function assemble(shellBinary) {
  rmSync(OUT, { recursive: true, force: true })
  await copyFile(shellBinary, join(OUT, LAUNCHER_NAME + '.exe'))
  await copyAppFiles(APP, 'win32')
  await copyNodeRuntime(join(APP, 'node'))
  // Inno 的快捷方式图标用这个单独文件（路径带版本号，换版后图标缓存失效）
  await mkdir(join(OUT, 'assets'), { recursive: true })
  await copyFile(join(ROOT, 'assets', 'dsh.ico'), join(OUT, 'assets', ICON_NAME))
  console.log(`已打包到 ${OUT}`)
}

function findIscc() {
  const candidates = [
    ISCC,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
  ]
  return candidates.find((path) => path && existsSync(path)) || ''
}

async function ensureInno() {
  const existing = findIscc()
  if (existing) return existing
  await mkdir(VENDOR, { recursive: true })
  const url = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'
  console.log(`下载 Inno Setup ${url}`)
  await download(url, INNO_SETUP)
  if (!existsSync(INNO_SETUP) || readFileSync(INNO_SETUP).length < 1_000_000) {
    throw new Error('Inno Setup 下载失败')
  }
  await mkdir(INNO_DIR, { recursive: true })
  console.log(`安装 Inno Setup 到 ${INNO_DIR}`)
  run(INNO_SETUP, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    `/DIR=${INNO_DIR}`,
  ])
  const installed = findIscc()
  if (!installed) throw new Error('Inno Setup 安装后找不到 ISCC.exe')
  return installed
}

async function buildInstaller() {
  const iscc = await ensureInno()
  // Inno 只打内层负载，最终分发的单文件由网页外壳内嵌它；用户不需要旁边再放一个 exe。
  const engineDir = join(VENDOR, 'installer-engine')
  await mkdir(engineDir, { recursive: true })
  console.log('编译安装引擎')
  run(iscc, [
    SETUP_ISS,
    `/DMyAppVersion=${PKG.version}`,
    `/DMyAppIcon=${ICON_NAME}`,
    `/O${engineDir}`,
    '/FDSH-Install-Engine',
  ])
  const previousEngine = process.env.DSH_INSTALL_ENGINE
  const cargo = cargoExecutable()
  try {
    process.env.DSH_INSTALL_ENGINE = join(engineDir, 'DSH-Install-Engine.exe')
    run(cargo, ['build', '--release', '--features', 'installer', '--bin', 'DSH-Setup'], join(ROOT, 'launcher'))
  } finally {
    if (previousEngine === undefined) delete process.env.DSH_INSTALL_ENGINE
    else process.env.DSH_INSTALL_ENGINE = previousEngine
  }
  const setup = join(ROOT, 'release', `${SETUP_NAME}.exe`)
  await copyFile(join(ROOT, 'launcher', 'target', 'release', 'DSH-Setup.exe'), setup)
  if (!existsSync(setup)) throw new Error(`没有生成 ${setup}`)
  const desktop = join(DESKTOP, `${SETUP_NAME}.exe`)
  await copyFile(setup, desktop)
  console.log(`安装包: ${setup}`)
  console.log(`已复制到桌面: ${desktop}`)
}

/**
 * 应用层增量资产：把 resources/app 打成 app-<版本>-win.zip + 清单（有私钥就签名）。
 * 不再有 runtime 资产——Electron 不随包发，按需下载的运行时由服务自己管。
 */
async function buildAppUpdateAssets() {
  const { buildAppAssets } = await import('./app-manifest.mjs')
  const assets = await buildAppAssets({ appDir: APP, version: PKG.version, platform: 'win' })
  const size = (assets.manifest.archive.size / 1048576).toFixed(1)
  console.log(`app 资产: ${basename(assets.zipPath)}（${size} MB）`)
  return assets
}

// 发布资产：先出 SBOM，再出覆盖「安装包 + app 资产 + SBOM」的发布清单（有私钥时顺带签名）。
// 没配密钥也不该让打包失败，所以这里只提示。
async function buildReleaseArtifacts() {
  const releaseDir = join(ROOT, 'release')
  const { path: sbomPath } = writeSbom({ releaseDir, version: PKG.version })
  console.log(`SBOM: ${sbomPath}`)
  const artifacts = collectArtifacts(releaseDir, [
    `${SETUP_NAME}.exe`,
    `app-${PKG.version}-win.zip`,
    basename(sbomPath),
  ])
  const { manifest, signed } = writeReleaseManifest({
    releaseDir,
    version: PKG.version,
    artifacts,
    components: collectComponents({ nodeDir: join(APP, 'node') }),
  })
  const where = manifest.tag ? `tag ${manifest.tag}` : '没有 tag'
  console.log(`发布清单: release/release-manifest.json（${where}${manifest.dirty ? '，有未提交改动' : ''}）`)
  console.log(signed ? '已用 release/release-key.pem 签名' : '未签名：没有 release/release-key.pem（node scripts/release-manifest.mjs keygen 生成）')
}

await downloadNode()
await assemble(buildShellBinary())
await buildInstaller()
await buildAppUpdateAssets()
await buildReleaseArtifacts()
