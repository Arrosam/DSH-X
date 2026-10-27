// Windows/macOS 打包：electron-builder 出安装包（NSIS / dmg+zip），外壳自更新交给 electron-updater。
//
// 安装包拆成两层：
// - release/shell-stage → resources/app：Electron 外壳（main/tray/updater/preload/tabs/model/pages）
//   + electron-updater 依赖。外壳版本读 shell/package.json，只有 Electron/主进程/托盘/更新器
//   变化时才需要发新安装包。
// - release/core-stage → resources/core：基线核心（server.js、public、compat/perf/packs、node 包装）。
//   核心另有 npm 通道（dsh-x-core-*），UI/服务端改动只发约 12MB 的 npm 包。
//
// electron-builder 直接打包 shell-stage，并把 core-stage 作为 extraResources 放进 resources/core。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  NODE_VERSION,
  PKG,
  ROOT,
  VENDOR,
  copyAppFiles,
  copyNpmModules,
  copyPnpm as copyPnpmModule,
  downloadNodeFile,
  run,
} from './pack-common.mjs'

const IS_MAC = process.platform === 'darwin'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const DIST = `node-v${NODE_VERSION}-${IS_MAC ? 'darwin' : 'win'}-${ARCH}`
const ARCHIVE = IS_MAC ? `${DIST}.tar.gz` : `${DIST}.zip`
const EXTRACTED = join(VENDOR, DIST)
const SHELL_STAGE = join(ROOT, 'release', 'shell-stage')
const CORE_STAGE = join(ROOT, 'release', 'core-stage')
const SHELL_DIR = join(ROOT, 'shell')
const ELECTRON_BUILDER = join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
const SHELL_PKG = JSON.parse(readFileSync(join(SHELL_DIR, 'package.json'), 'utf8'))
const ELECTRON_VERSION = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version

async function ensureNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, IS_MAC ? 'bin/node' : 'node.exe'))) return
  const archive = join(VENDOR, ARCHIVE)
  await downloadNodeFile(ARCHIVE, archive)
  if (IS_MAC) run('tar', ['-xzf', archive, '-C', VENDOR])
  else run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${archive}' '${VENDOR}'`])
}

/**
 * 核心的 node/ 目录：只有 npm/pnpm 的 JS 和包装脚本；node 本体由 Electron/外壳提供。
 * 核心包跨平台，所以两套包装都写：Windows 用 node.cmd / pnpm.cmd，mac 用 sh 脚本；
 * 同一个目录在两边都能用，PATH 按平台挑到对应的那个。
 */
async function copyNodeRuntime(nodeDir) {
  await mkdir(nodeDir, { recursive: true })
  const modules = join(EXTRACTED, IS_MAC ? 'lib' : '', 'node_modules')
  await copyNpmModules(modules, nodeDir)
  await copyPnpmModule(nodeDir, join(modules, 'npm', 'bin', 'npm-cli.js'))

  // POSIX：DSH_ELECTRON_BIN 由外壳/CLI 设置；没有时依次试安装版的 Windows / mac 布局
  const nodeShim = join(nodeDir, 'node')
  await writeFile(nodeShim, [
    '#!/bin/sh',
    'if [ -n "$DSH_ELECTRON_BIN" ]; then ELECTRON_RUN_AS_NODE=1 exec "$DSH_ELECTRON_BIN" "$@"; fi',
    'dir="$(cd "$(dirname "$0")" && pwd)"',
    'if [ -x "$dir/../../../DSH.exe" ]; then ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../DSH.exe" "$@"; fi',
    'ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../MacOS/DSH" "$@"',
    '',
  ].join('\n'))
  await chmod(nodeShim, 0o755)
  const shims = { npm: 'npm/bin/npm-cli.js', npx: 'npm/bin/npx-cli.js', pnpm: 'pnpm/bin/pnpm.cjs', pnpx: 'pnpm/bin/pnpx.cjs' }
  for (const [name, cli] of Object.entries(shims)) {
    const file = join(nodeDir, name)
    await writeFile(file, [
      '#!/bin/sh',
      'dir="$(cd "$(dirname "$0")" && pwd)"',
      `exec "$dir/node" "$dir/node_modules/${cli}" "$@"`,
      '',
    ].join('\n'))
    await chmod(file, 0o755)
  }

  // Windows
  await writeFile(join(nodeDir, 'node.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "ELECTRON_RUN_AS_NODE=1"',
    'IF DEFINED DSH_ELECTRON_BIN (',
    '  "%DSH_ELECTRON_BIN%" %*',
    ') ELSE (',
    '  "%~dp0..\\..\\..\\DSH.exe" %*',
    ')',
    '',
  ].join('\r\n'))
  await writeFile(join(nodeDir, 'pnpm.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "PNPM_JS=%~dp0node_modules\\pnpm\\bin\\pnpm.cjs"',
    'call "%~dp0node.cmd" "%PNPM_JS%" %*',
    '',
  ].join('\r\n'))
  await writeFile(join(nodeDir, 'pnpx.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'call "%~dp0node.cmd" "%~dp0node_modules\\pnpm\\bin\\pnpx.cjs" %*',
    '',
  ].join('\r\n'))
}

/** 基线核心：安装包里的 resources/core，也是 npm 核心包的来源。 */
async function buildCoreStage() {
  await rm(CORE_STAGE, { recursive: true, force: true })
  await mkdir(CORE_STAGE, { recursive: true })
  await copyAppFiles(CORE_STAGE)
  await copyNodeRuntime(join(CORE_STAGE, 'node'))
  await writeFile(join(CORE_STAGE, 'package.json'), `${JSON.stringify({
    // 核心包跨平台：同一个 dsh-x-core 在 Windows 和 mac 上都能用，只有外壳按平台分开
    name: 'dsh-x-core',
    productName: 'DSH',
    version: PKG.version,
    private: true,
    type: 'module',
    main: 'server.js',
    // 核心按哪个 Electron 版本构建；外壳发现不一致就让用户更新外壳
    dshX: { electron: ELECTRON_VERSION },
  }, null, 2)}\n`)
  console.log(`核心层：${CORE_STAGE}（${PKG.version}）`)
}

/** 外壳：安装包的 resources/app；版本来自 shell/package.json，和核心版本分开。 */
async function buildShellStage() {
  await rm(SHELL_STAGE, { recursive: true, force: true })
  await mkdir(SHELL_STAGE, { recursive: true })
  await cp(SHELL_DIR, join(SHELL_STAGE, 'shell'), { recursive: true })
  // 托盘 / 窗口图标（shell/main.mjs 的 ICON_FILE 指向 app 根目录的 assets）
  await cp(join(ROOT, 'assets'), join(SHELL_STAGE, 'assets'), { recursive: true })
  await writeFile(join(SHELL_STAGE, 'package.json'), `${JSON.stringify({
    name: 'dsh-x-shell',
    productName: 'DSH-X',
    version: SHELL_PKG.version,
    private: true,
    type: 'module',
    description: 'DSH-X desktop shell',
    author: 'yyh',
    main: 'shell/main.mjs',
    dependencies: { 'electron-updater': '^6.8.11' },
  }, null, 2)}\n`)
  // 外壳自更新依赖装进 app 层
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: SHELL_STAGE, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' })
  if (npm.status !== 0) throw new Error('npm install (shell stage) failed')
  console.log(`外壳层：${SHELL_STAGE}（${SHELL_PKG.version}）`)
}

function buildInstaller() {
  if (!existsSync(ELECTRON_BUILDER)) throw new Error('缺少 electron-builder，先 npm install')
  const args = [ELECTRON_BUILDER, '--config', join(ROOT, 'electron-builder.config.mjs'), '--publish', 'never']
  if (IS_MAC) args.push('--mac', process.arch === 'arm64' ? '--arm64' : '--x64')
  else args.push('--win')
  run(process.execPath, args)
  console.log(`安装包输出：${join(ROOT, 'release', 'eb')}`)
}

await ensureNode()
await buildCoreStage()
await buildShellStage()
buildInstaller()
