import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PKG,
  ROOT,
  VENDOR,
  buildShellBinary,
  copyAppFiles,
  copyNpmModules,
  copyPnpm as copyPnpmModule,
  downloadNodeFile,
  nodeArchiveFile,
  run,
} from './pack-common.mjs'
import { LAUNCHER_NAME, MAC_APP_NAME, MAC_BUNDLE_ID } from '../platform.js'
import { macSigningIdentity, signMacBundle } from './mac-signing.mjs'

/**
 * macOS 打包：release/DSH-X.app + release/DSH-X-mac-<arch>.dmg。
 *
 * 安装包里没有 Electron，也没有 Node：外壳是 launcher/ 的 Rust 二进制（WKWebView），
 * Node 由外壳首次运行时下载到数据目录，Electron 由服务按需下载。
 * 包的布局（platform.js 的 appBundle 按它找文件，自更新按它换包）：
 *   DSH-X.app/Contents/MacOS/DSH            原生外壳
 *   DSH-X.app/Contents/Resources/app/…      启动器自己的代码 + shell/ + npm/pnpm 的 JS 包
 *   DSH-X.app/Contents/Resources/AppIcon.icns
 *
 * Resources/app 是普通目录：原生外壳用下载的 Node 跑 app 里的 start.js；按需下载的 Electron
 * 也用它当应用目录（package.json 的 main 指向 shell/main.mjs）。node 本体不在里面——
 * 签名后的 .app 不能写，Node 只能放数据目录。
 *
 * dmg 的文件名带架构，和 server.js 的 APP_SETUP 对上——自更新按它去发布页取包。
 * 两个架构各自在自己的机器上打（CI 是两台 runner）：跨架构构建要另装 Rust target、
 * 而且本机也没法验证，这里不猜。
 */

const ARCH = process.env.DSH_MAC_ARCH || process.arch
const ARCHS = new Set(['arm64', 'x64'])
if (!ARCHS.has(ARCH)) throw new Error(`不支持的架构：${ARCH}（只支持 ${[...ARCHS].join(' / ')}）`)
if (ARCH !== process.arch) throw new Error(`DSH_MAC_ARCH=${ARCH} 与当前机器 ${process.arch} 不一致：跨架构请在对应架构的机器上打包`)
macSigningIdentity() // 缺固定证书时在下载 Node / 编译 Rust 前就中止正式构建

const NODE_TARBALL = nodeArchiveFile(`darwin-${ARCH}`)
const DIST = NODE_TARBALL.replace(/\.tar\.gz$/, '')
const TARBALL_PATH = join(VENDOR, NODE_TARBALL)
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
/**
 * 最低系统版本 11.0：打包出来的外壳二进制（LC_BUILD_VERSION 的 minos 就是 11.0，
 * 即 rustc 在 aarch64-apple-darwin 上的默认部署目标）与外壳首次运行要下载的 Node 22
 * 官方二进制（同一版本实测 minos 也是 11.0）都是这个下限。比 Electron 时代的 13 低。
 */
const MIN_MACOS = '11.0'
/** iconset 需要的尺寸（每个再配一张 @2x）。 */
const ICON_SIZES = [16, 32, 128, 256, 512]

/**
 * 打包时下载一份 Node 发行包，只是为了抄出 npm / pnpm 的 JS 包。
 * node 本体不进安装包（安装包也不带运行时）。
 */
async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'lib', 'node_modules', 'npm'))) return
  await downloadNodeFile(NODE_TARBALL, TARBALL_PATH)
  run('tar', ['-xzf', TARBALL_PATH, '-C', VENDOR])
}

/**
 * app 层的 node/ 目录：只有 npm / pnpm 的 JS 包和命令行包装，没有 node 本体。
 * 包装脚本调用 PATH 上的 `node` —— 原生外壳启动服务时把下载运行时所在的 bin
 * 目录前置进了 PATH（服务再传给 dsh 子进程），app 层自己的 node/ 里没有 node，
 * 不会遮蔽运行时那份。发行包里的 npm/npx 是指向 ../lib/node_modules 的符号链接，
 * 换了布局就断了，所以自己写包装。
 */
async function copyNodeRuntime() {
  const nodeDir = join(APP, 'node')
  await mkdir(nodeDir, { recursive: true })
  const modules = join(EXTRACTED, 'lib', 'node_modules')
  await copyNpmModules(modules, nodeDir)
  await copyPnpmModule(nodeDir, join(modules, 'npm', 'bin', 'npm-cli.js'))
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
      `exec node "$dir/node_modules/${cli}" "$@"`,
      '',
    ].join('\n'))
    await chmod(file, 0o755)
  }
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

/**
 * Info.plist 自己写（不再由 @electron/packager 生成）。基础键之外只留真正需要的：
 * 图标、最低系统、深色模式与高分屏。麦克风/摄像头用途说明不用了——外壳里只有管理页，
 * dsh 的语音输入在系统浏览器或按需下载的 Electron 窗口里，不在这个签名的 .app 里。
 */
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

async function assemble(shellBinary) {
  rmSync(BUNDLE, { recursive: true, force: true })
  await mkdir(join(CONTENTS, 'MacOS'), { recursive: true })
  await copyFile(shellBinary, join(CONTENTS, 'MacOS', LAUNCHER_NAME))
  await chmod(join(CONTENTS, 'MacOS', LAUNCHER_NAME), 0o755)
  await copyAppFiles(APP, 'darwin')
  await copyNodeRuntime()
  buildIcon(join(CONTENTS, 'Resources', ICON_FILE))
  await writeFile(join(CONTENTS, 'Info.plist'), infoPlist())
  // 有些老工具仍按 PkgInfo 认「这是个应用包」；两行字，顺手写上
  await writeFile(join(CONTENTS, 'PkgInfo'), 'APPL????')
  // 签名放在所有文件都齐之后：改 resources 里的任何东西都会让已有签名失效
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
 * 卸载临时卷。卷改名后 Finder / Spotlight / diskimages-help 还会短暂占着它，
 * 立刻 detach 会「Resource busy」——跑得慢的 intel runner 上几乎每次都踩到；
 * 所以先反复等它松手，实在不行再 -force 强卸（内容已写完，强卸不会丢窗口布局）。
 */
function detachVolume(device) {
  let last = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const forced = attempt >= 6
    const result = spawnSync('hdiutil', forced ? ['detach', device, '-force'] : ['detach', device], { encoding: 'utf8' })
    if (result.status === 0) return
    last = result
    run('sleep', ['2'])
  }
  throw new Error(`hdiutil detach ${device} failed: ${last?.stderr || last?.stdout || ''}`)
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
  // ditto 保留符号链接与权限位；用 cp -R 会把 .app 里的链接语义改掉
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
    detachVolume(device)
  }

  rmSync(DMG, { force: true })
  // UDBZ（bzip2）比 UDZO（zlib-9）压得更小；这里只剩十几 MB 的应用包，差距不大但没理由不用
  run('hdiutil', ['convert', rw, '-format', 'UDBZ', '-o', DMG])
  rmSync(rw, { force: true })
  console.log(`安装包: ${DMG}`)
}

await downloadNode()
await assemble(buildShellBinary())
buildDmg()
