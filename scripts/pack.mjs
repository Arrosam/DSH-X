// Windows/macOS 打包：electron-builder 出安装包（NSIS / dmg+zip），外壳自更新交给 electron-updater。
//
// 安装包内容 = Electron 外壳 + 一份核心（app 层）。核心另有 npm 通道（dsh-x-core-*），
// 所以这里不再产 app zip/清单；electron-builder 会生成 latest.yml / blockmap。
//
// 构建前先把 app 层组装到 release/app-stage：APP_FILES + public/assets/perf/compat/packs +
// shell/ + node/（npm/pnpm 包装）+ electron-updater 依赖。electron-builder 直接打包这个目录。

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
const STAGE = join(ROOT, 'release', 'app-stage')
const SHELL_DIR = join(ROOT, 'shell')
const ELECTRON_BUILDER = join(ROOT, 'node_modules', 'electron-builder', 'cli.js')

async function ensureNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, IS_MAC ? 'bin/node' : 'node.exe'))) return
  const archive = join(VENDOR, ARCHIVE)
  await downloadNodeFile(ARCHIVE, archive)
  if (IS_MAC) run('tar', ['-xzf', archive, '-C', VENDOR])
  else run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${archive}' '${VENDOR}'`])
}

/** 核心的 node/ 目录：只有 npm/pnpm 的 JS 和包装脚本；node 本体由 Electron/外壳提供。 */
async function copyNodeRuntime(nodeDir) {
  await mkdir(nodeDir, { recursive: true })
  if (IS_MAC) {
    const nodeShim = join(nodeDir, 'node')
    await writeFile(nodeShim, [
      '#!/bin/sh',
      'if [ -n "$DSH_ELECTRON_BIN" ]; then ELECTRON_RUN_AS_NODE=1 exec "$DSH_ELECTRON_BIN" "$@"; fi',
      'ELECTRON_RUN_AS_NODE=1 exec "$(dirname "$0")/../../../MacOS/DSH" "$@"',
      '',
    ].join('\n'))
    const modules = join(EXTRACTED, 'lib', 'node_modules')
    await copyNpmModules(modules, nodeDir)
    await copyPnpmModule(nodeDir, join(modules, 'npm', 'bin', 'npm-cli.js'))
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
    return
  }
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
  await writeFile(join(nodeDir, 'node'), [
    '#!/bin/sh',
    'if [ -n "$DSH_ELECTRON_BIN" ]; then ELECTRON_RUN_AS_NODE=1 exec "$DSH_ELECTRON_BIN" "$@"; fi',
    'ELECTRON_RUN_AS_NODE=1 exec "$(dirname "$0")/../../../DSH.exe" "$@"',
    '',
  ].join('\n'))
  await copyNpmModules(join(EXTRACTED, 'node_modules'), nodeDir)
  await copyPnpmModule(nodeDir, join(EXTRACTED, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  await writeFile(join(nodeDir, 'pnpm.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "PNPM_JS=%~dp0node_modules\\pnpm\\bin\\pnpm.cjs"',
    'call "%~dp0node.cmd" "%PNPM_JS%" %*',
    '',
  ].join('\r\n'))
  await writeFile(join(nodeDir, 'pnpm'), [
    '#!/bin/sh',
    'exec node "$(dirname "$0")/node_modules/pnpm/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'))
  await writeFile(join(nodeDir, 'pnpx.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'call "%~dp0node.cmd" "%~dp0node_modules\\pnpm\\bin\\pnpx.cjs" %*',
    '',
  ].join('\r\n'))
}

async function buildStage() {
  await rm(STAGE, { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })
  await copyAppFiles(STAGE, IS_MAC ? 'darwin' : 'win32')
  await cp(SHELL_DIR, join(STAGE, 'shell'), { recursive: true })
  await copyNodeRuntime(join(STAGE, 'node'))
  await writeFile(join(STAGE, 'package.json'), `${JSON.stringify({
    name: 'dsh-x',
    productName: 'DSH-X',
    version: PKG.version,
    private: true,
    type: 'module',
    main: 'shell/main.mjs',
    dependencies: { 'electron-updater': '^6.8.11' },
  }, null, 2)}\n`)
  // 外壳自更新依赖装进 app 层；核心 npm 包也会带上它
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: STAGE, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' })
  if (npm.status !== 0) throw new Error('npm install (app stage) failed')
  console.log(`app 层：${STAGE}`)
}

function buildInstaller() {
  if (!existsSync(ELECTRON_BUILDER)) throw new Error('缺少 electron-builder，先 npm install')
  const args = [ELECTRON_BUILDER, '--config', join(ROOT, 'electron-builder.config.mjs'), '--publish', 'never']
  if (IS_MAC) args.push('--mac')
  else args.push('--win')
  run(process.execPath, args)
  console.log(`安装包输出：${join(ROOT, 'release', 'eb')}`)
}

await ensureNode()
await buildStage()
buildInstaller()
