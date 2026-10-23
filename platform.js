import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 平台差异集中在这里：启动器的每用户目录、自带运行时布局、打包后的外壳位置。
 * 打包脚本（scripts/pack.mjs）按同样的约定摆文件，两边要一起改。
 */

const ROOT = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** 自带运行时里 node 的文件名。两个平台都是扁平布局：<安装目录>/node/<它>，npm/pnpm 在同目录的 node_modules 里。 */
export const NODE_BINARY = IS_WINDOWS ? 'node.exe' : 'node'

/** 管理服务是不是跑在 Electron 主进程里（macOS 外壳，见 shell/main.mjs）。 */
export const IN_ELECTRON = Boolean(process.versions.electron)

/**
 * 拉子进程（dsh、npm、pnpm）用的 node。
 *
 * 普通情况下就是正在跑的这个 node。Electron 外壳里 process.execPath 是 Electron 本体：
 * 拿它去跑 dsh 得额外设 ELECTRON_RUN_AS_NODE，而且 Node 版本会跟着 Electron 走，
 * 和 Windows 版、和 dsh 测过的运行时不一致。所以那边改用自带运行时（node/node），
 * 源码运行（npm run electron）时没有自带运行时，就用 PATH 上的 node；
 * DSH_RUNTIME_NODE 可以显式指定。都找不到返回空串——不在这里抛：本模块被所有人 import，
 * 一抛整个外壳连错误窗口都开不出来；由外壳在启动时检查并说明（见 shell/main.mjs）。
 */
export function runtimeNode(env = process.env, root = ROOT, inElectron = IN_ELECTRON) {
  if (!inElectron) return process.execPath
  if (env.DSH_RUNTIME_NODE) return env.DSH_RUNTIME_NODE
  const bundled = join(root, 'node', NODE_BINARY)
  if (existsSync(bundled)) return bundled
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, NODE_BINARY)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/** 进程启动时定一次；server.js / registry.js / settings.js 都从这里取，别再各自读 process.execPath。 */
export const RUNTIME_NODE = runtimeNode()

/** 每用户目录的名字（settings.json、manager.log、webview 数据都在它下面；Rust 外壳里有同名常量）。 */
const APP_DIR_NAME = 'DSH'

/** macOS 包的名字和 bundle id：Info.plist、LaunchAgent、自更新都认它们。 */
export const MAC_APP_NAME = 'DSH-X.app'
export const MAC_BUNDLE_ID = 'io.github.yyh-001.dsh-x'
/** 外壳可执行文件名（Windows：Cargo.toml 的 [[bin]] name；macOS：Electron 包的 executableName）。 */
export const LAUNCHER_NAME = 'DSH'

/**
 * 启动器的每用户目录；没有就返回空串（调用方退回安装目录下的 data/）。
 * Windows 沿用 %APPDATA%\DSH；macOS 用 ~/Library/Application Support/DSH——
 * .app 包里不能写：一更新整个包就被换掉，而且改包内文件会破坏签名。
 */
export function userAppDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME)
  if (env.APPDATA) return join(env.APPDATA, APP_DIR_NAME)
  return ''
}

/** settings.json 与日志所在的目录。 */
export const APP_DIR = userAppDir() || join(ROOT, 'data')

/**
 * 当前代码所在的 .app 包路径；不是从包里跑（源码运行）就返回空串。
 * 打包布局是 <X>.app/Contents/Resources/app/<本文件>。
 */
export function appBundle(root = ROOT) {
  const resources = dirname(root)
  const contents = dirname(resources)
  const bundle = dirname(contents)
  if (basename(root) !== 'app' || basename(resources) !== 'Resources' || basename(contents) !== 'Contents') return ''
  return bundle.endsWith('.app') ? bundle : ''
}

/** 打包后的原生外壳（Windows 的 DSH.exe / macOS 包里的 Contents/MacOS/DSH）；源码运行时返回空串。 */
export function launcherExecutable() {
  if (IS_WINDOWS) {
    const exe = join(ROOT, `${LAUNCHER_NAME}.exe`)
    return existsSync(exe) ? exe : ''
  }
  const bundle = IS_MAC ? appBundle() : ''
  const exe = bundle ? join(bundle, 'Contents', 'MacOS', LAUNCHER_NAME) : ''
  return exe && existsSync(exe) ? exe : ''
}
