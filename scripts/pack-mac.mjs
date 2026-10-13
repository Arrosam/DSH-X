import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  NODE_VERSION,
  PKG,
  ROOT,
  VENDOR,
  copyAppFiles,
  copyNpmModules,
  copyPnpm,
  downloadNodeFile,
  run,
} from './pack-common.mjs'
import { LAUNCHER_NAME, MAC_APP_NAME, MAC_BUNDLE_ID, NODE_BINARY } from '../platform.js'
import { macSigningIdentity, signMacBundle } from './mac-signing.mjs'

/**
 * macOS 打包：release/DSH-X.app + release/DSH-X-mac-<arch>.dmg。
 *
 * 包的布局（platform.js 的 appBundle / 外壳的 app_root 都按它找文件）：
 *   DSH-X.app/Contents/MacOS/DSH            原生外壳（launcher/）
 *   DSH-X.app/Contents/Resources/app/…      和 Windows 安装目录一样的内容，node 在 app/node/node
 *   DSH-X.app/Contents/Resources/AppIcon.icns
 *
 * dmg 的文件名带架构，和 server.js 的 APP_SETUP 对上——自更新按它去发布页取包。
 * 默认打当前机器的架构；DSH_MAC_ARCH=x64 / arm64 可以指定（外壳交叉编译需要装好对应的 rust target）。
 */

const ARCH = process.env.DSH_MAC_ARCH || process.arch
const RUST_TARGETS = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }
const RUST_TARGET = RUST_TARGETS[ARCH]
if (!RUST_TARGET) throw new Error(`不支持的架构：${ARCH}（只支持 ${Object.keys(RUST_TARGETS).join(' / ')}）`)
macSigningIdentity() // 缺固定证书时在下载 Node / 编译 Rust 前就中止正式构建

const DIST = `node-v${NODE_VERSION}-darwin-${ARCH}`
const TARBALL = `${DIST}.tar.gz`
const TARBALL_PATH = join(VENDOR, TARBALL)
const EXTRACTED = join(VENDOR, DIST)
const RELEASE = join(ROOT, 'release')
const BUNDLE = join(RELEASE, MAC_APP_NAME)
const CONTENTS = join(BUNDLE, 'Contents')
const APP = join(CONTENTS, 'Resources', 'app')
const ICON_FILE = 'AppIcon.icns'
const DMG = join(RELEASE, `DSH-X-mac-${ARCH}.dmg`)
const DMG_VOLUME = 'DSH-X'
const DMG_BACKGROUND = 'background.tiff'
const DS_STORE_WAIT_SECONDS = 20
/** Finder 窗口 bounds 含标题栏，内容区要完整露出背景图就得加上这一截。 */
const DMG_TITLE_BAR = 28
/** dmg 窗口布局（点，左上角为原点）：背景图和 Finder 摆图标共用这一份。 */
const DMG_LAYOUT = { width: 640, height: 440, iconSize: 112, appX: 170, appsX: 470, iconY: 190 }
// 和 Windows 版一样读 npmmirror；最低系统版本跟 Node 22 官方二进制的要求走
const MIN_MACOS = '11.0'
/** iconset 需要的尺寸（每个再配一张 @2x）。 */
const ICON_SIZES = [16, 32, 128, 256, 512]

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'bin', 'node'))) return
  await downloadNodeFile(TARBALL, TARBALL_PATH)
  run('tar', ['-xzf', TARBALL_PATH, '-C', VENDOR])
}

/**
 * 自带运行时摆成和 Windows 一样的扁平布局（node/node + node/node_modules），
 * server.js 的 withBundledRuntime、registry.js 的 LOCAL_NODE 只认这一种。
 * 发行包里的 npm/npx 是指向 ../lib/node_modules 的符号链接，换了布局就断了，所以自己写包装。
 */
async function copyNodeRuntime() {
  const nodeDir = join(APP, 'node')
  await mkdir(nodeDir, { recursive: true })
  await copyFile(join(EXTRACTED, 'bin', 'node'), join(nodeDir, NODE_BINARY))
  await chmod(join(nodeDir, NODE_BINARY), 0o755)
  const modules = join(EXTRACTED, 'lib', 'node_modules')
  await copyNpmModules(modules, nodeDir)
  await copyPnpm(nodeDir, join(modules, 'npm', 'bin', 'npm-cli.js'))
  const shims = {
    npm: 'npm/bin/npm-cli.js',
    npx: 'npm/bin/npx-cli.js',
    pnpm: 'pnpm/bin/pnpm.cjs',
    pnpx: 'pnpm/bin/pnpx.cjs',
  }
  for (const [name, cli] of Object.entries(shims)) {
    const file = join(nodeDir, name)
    await writeFile(file, [
      '#!/bin/sh',
      'dir="$(cd "$(dirname "$0")" && pwd)"',
      `exec "$dir/${NODE_BINARY}" "$dir/node_modules/${cli}" "$@"`,
      '',
    ].join('\n'))
    await chmod(file, 0o755)
  }
}

function buildLauncher() {
  run('cargo', ['build', '--release', '--target', RUST_TARGET], join(ROOT, 'launcher'))
  return join(ROOT, 'launcher', 'target', RUST_TARGET, 'release', LAUNCHER_NAME)
}

/** assets/icon.png（512 母版）→ AppIcon.icns。 */
function buildIcon(dest) {
  const iconset = join(tmpdir(), `dsh-x-${process.pid}.iconset`)
  rmSync(iconset, { recursive: true, force: true })
  run('mkdir', ['-p', iconset])
  const master = join(ROOT, 'assets', 'icon.png')
  for (const size of ICON_SIZES) {
    run('sips', ['-z', String(size), String(size), master, '--out', join(iconset, `icon_${size}x${size}.png`)])
    run('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(iconset, `icon_${size}x${size}@2x.png`)])
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', dest])
  rmSync(iconset, { recursive: true, force: true })
}

function infoPlist() {
  const entries = {
    CFBundleDevelopmentRegion: 'zh_CN',
    CFBundleDisplayName: 'DSH-X',
    CFBundleExecutable: LAUNCHER_NAME,
    CFBundleIconFile: ICON_FILE,
    CFBundleIdentifier: MAC_BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'DSH-X',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: PKG.version,
    CFBundleVersion: PKG.version,
    LSApplicationCategoryType: 'public.app-category.developer-tools',
    LSMinimumSystemVersion: MIN_MACOS,
    NSHumanReadableCopyright: 'Copyright (C) 2026 yyh',
  }
  const body = Object.entries(entries)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    body,
    // 支持深色模式、高分屏（不写的话 WKWebView 在 Retina 上是糊的）
    '  <key>NSHighResolutionCapable</key>\n  <true/>',
    '  <key>NSRequiresAquaSystemAppearance</key>\n  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

async function assemble(launcher) {
  rmSync(BUNDLE, { recursive: true, force: true })
  await mkdir(join(CONTENTS, 'MacOS'), { recursive: true })
  await copyAppFiles(APP)
  await copyNodeRuntime()
  await copyFile(launcher, join(CONTENTS, 'MacOS', LAUNCHER_NAME))
  await chmod(join(CONTENTS, 'MacOS', LAUNCHER_NAME), 0o755)
  buildIcon(join(CONTENTS, 'Resources', ICON_FILE))
  await writeFile(join(CONTENTS, 'Info.plist'), infoPlist())
  await writeFile(join(CONTENTS, 'PkgInfo'), 'APPL????')
  signMacBundle(BUNDLE)
  console.log(`已打包到 ${BUNDLE}`)
}

/** 背景图（标题、箭头、首次打开指引）：1x + 2x 合成一张多分辨率 tiff，Retina 上不糊。 */
function buildDmgBackground(dest) {
  const script = join(ROOT, 'scripts', 'make-dmg-background.swift')
  const layout = JSON.stringify(DMG_LAYOUT)
  const pngs = [1, 2].map((scale) => {
    const png = join(tmpdir(), `dsh-x-dmg-bg-${process.pid}@${scale}x.png`)
    run('swift', [script, png, String(scale), layout])
    return png
  })
  run('tiffutil', ['-cathidpicheck', ...pngs, '-out', dest])
  for (const png of pngs) rmSync(png, { force: true })
}

/** 用 Finder 摆好窗口：图标视图、隐藏工具栏、背景图、两个图标的位置。 */
function layoutDmgWindow(mount) {
  const { width, height, iconSize, appX, appsX, iconY } = DMG_LAYOUT
  // 按挂载路径找卷，不按卷名：机器上可能还挂着旧的同名安装盘
  const script = `
    tell application "Finder"
      tell folder (POSIX file "${mount}" as alias)
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 120, ${200 + width}, ${120 + height + DMG_TITLE_BAR}}
        set opts to the icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to ${iconSize}
        set text size of opts to 13
        set background picture of opts to (POSIX file "${mount}/.background/${DMG_BACKGROUND}" as alias)
        set position of item "${MAC_APP_NAME}" of container window to {${appX}, ${iconY}}
        set position of item "Applications" of container window to {${appsX}, ${iconY}}
        close
        -- 重开一次再关：Finder 只在关掉已改过的窗口时落盘 .DS_Store（create-dmg 同样做法）
        open
        update without registering applications
        delay 2
        close
      end tell
    end tell`
  run('osascript', ['-e', script])
}

/**
 * 挂载可写镜像，返回卷设备和挂载点。必须挂在 /Volumes 下（Finder 不给别处的卷写 .DS_Store），
 * 所以挂载点让 hdiutil 按卷名自己挑。
 */
function attachDmg(image) {
  const result = spawnSync('hdiutil', ['attach', image, '-readwrite', '-noverify', '-noautoopen'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`hdiutil attach ${image} failed: ${result.stderr}`)
  const volume = result.stdout.split('\n').map((line) => line.split('\t').map((field) => field.trim()))
    .find((fields) => fields.at(-1).startsWith('/Volumes/'))
  if (!volume) throw new Error(`hdiutil attach 没给出挂载点：${result.stdout}`)
  return { device: volume[0], mount: volume.at(-1) }
}

/** Finder 关窗后才异步写 .DS_Store；不等它就卸载的话布局会丢。 */
function waitForFinderLayout(mount) {
  const store = join(mount, '.DS_Store')
  for (let i = 0; i < DS_STORE_WAIT_SECONDS; i += 1) {
    if (existsSync(store)) return
    run('sleep', ['1'])
  }
  throw new Error(`${DS_STORE_WAIT_SECONDS} 秒内 Finder 没写出 .DS_Store`)
}

/**
 * dmg 里放包本体和一个指向 /Applications 的链接，拖过去就装好了。
 * 先做可写镜像、挂上用 Finder 摆窗口（写进卷里的 .DS_Store），再压成只读 UDZO。
 * 摆窗口要求能控制 Finder（第一次跑会弹「自动化」授权）；没有图形会话时退回朴素布局。
 */
function buildDmg() {
  const staging = join(tmpdir(), `dsh-x-dmg-${process.pid}`)
  const rw = join(tmpdir(), `dsh-x-dmg-${process.pid}-rw.dmg`)
  rmSync(staging, { recursive: true, force: true })
  run('mkdir', ['-p', join(staging, '.background')])
  run('ditto', [BUNDLE, join(staging, MAC_APP_NAME)])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', join(staging, MAC_APP_NAME)])
  run('ln', ['-s', '/Applications', join(staging, 'Applications')])
  buildDmgBackground(join(staging, '.background', DMG_BACKGROUND))
  rmSync(rw, { force: true })
  // 摆窗口时用一个独一无二的临时卷名：Finder 按卷名认窗口，机器上挂着旧的「DSH-X」安装盘时
  // 它会把设置写到别的卷上。摆完再改回正式卷名。
  const buildVolume = `${DMG_VOLUME}-build-${process.pid}`
  run('hdiutil', ['create', '-volname', buildVolume, '-srcfolder', staging, '-ov', '-format', 'UDRW', rw])
  rmSync(staging, { recursive: true, force: true })

  const { device, mount } = attachDmg(rw)
  try {
    layoutDmgWindow(mount)
    waitForFinderLayout(mount)
    // 卷图标用应用图标
    run('cp', [join(CONTENTS, 'Resources', ICON_FILE), join(mount, '.VolumeIcon.icns')])
    run('SetFile', ['-a', 'C', mount])
  } catch (error) {
    console.warn(`dmg 窗口布局失败，用默认布局：${error.message}`)
  } finally {
    run('sync', [])
    run('diskutil', ['rename', device, DMG_VOLUME])
    // 改名后挂载点跟着变，按设备卸载
    run('hdiutil', ['detach', device])
  }

  rmSync(DMG, { force: true })
  run('hdiutil', ['convert', rw, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', DMG])
  rmSync(rw, { force: true })
  console.log(`安装包: ${DMG}`)
}

await downloadNode()
const launcher = buildLauncher()
await assemble(launcher)
buildDmg()
