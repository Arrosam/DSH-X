import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 平台差异集中在这里：启动器的每用户目录、自带运行时布局、打包后的外壳位置。
 * 打包脚本（scripts/pack.mjs）按同样的约定摆文件，两边要一起改。
 */

const ROOT = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** 管理服务是不是跑在 Electron 主进程里（Windows/macOS 外壳都是，见 shell/main.mjs）。 */
export const IN_ELECTRON = Boolean(process.versions.electron)

/** 打包后的 Electron 外壳（`electron .` 源码运行时 process.defaultApp 为 true）。 */
export const PACKAGED = IN_ELECTRON && !process.defaultApp

/**
 * 拉子进程（dsh、npm、pnpm）用的 node。
 *
 * 普通情况下就是正在跑的这个 node（源码运行 = 系统 node）。Electron 外壳里没有单独的 node
 * 可执行文件：Electron 本体就带着 Node（44 起是 Node 24），子进程设 ELECTRON_RUN_AS_NODE=1
 * 后按 node 跑。所以这里把 Electron 本体当 node 返回，环境变量由 RUNTIME_NODE_ENV 补。
 * （0.1.19 及以前的安装包在 node/ 下自带过一份 node，保留 existsSync 判断兼容它们。）
 * DSH_RUNTIME_NODE 可以显式指定（打包脚本和开发测试用）。
 */
export function runtimeNode(env = process.env, root = ROOT, inElectron = IN_ELECTRON) {
  if (!inElectron) return process.execPath
  if (env.DSH_RUNTIME_NODE) return env.DSH_RUNTIME_NODE
  const bundled = join(root, 'node', IS_WINDOWS ? 'node.exe' : 'node')
  if (existsSync(bundled)) return bundled
  return process.execPath
}

/** 进程启动时定一次；server.js / registry.js / settings.js 都从这里取，别再各自读 process.execPath。 */
export const RUNTIME_NODE = runtimeNode()

/** RUNTIME_NODE 是不是 Electron 本体（Electron 自带 Node）。 */
export function runtimeNodeEnv(nodePath = RUNTIME_NODE, execPath = process.execPath, inElectron = IN_ELECTRON) {
  if (!inElectron || !nodePath) return {}
  const left = IS_WINDOWS ? String(nodePath).toLowerCase() : String(nodePath)
  const right = IS_WINDOWS ? String(execPath).toLowerCase() : String(execPath)
  return left === right ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/** 过滤掉 node_modules 里随包发的 node 之后的环境变量；spawn 子进程时展开它。 */
export const RUNTIME_NODE_ENV = runtimeNodeEnv()

/** 每用户目录的名字（settings.json、manager.log、webview 数据都在它下面；旧 Rust 外壳里有同名常量）。 */
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
    // Electron 外壳里 DSH.exe 就是 process.execPath（打包后在安装目录根上，不在 resources/app 里）。
    // 源码运行（npm run electron）时 defaultApp 为真，execPath 是 node_modules 里的 electron.exe，
    // 不能让开机自启把它写进注册表。
    if (IN_ELECTRON) return process.defaultApp ? '' : process.execPath
    const exe = join(ROOT, `${LAUNCHER_NAME}.exe`)
    return existsSync(exe) ? exe : ''
  }
  const bundle = IS_MAC ? appBundle() : ''
  const exe = bundle ? join(bundle, 'Contents', 'MacOS', LAUNCHER_NAME) : ''
  return exe && existsSync(exe) ? exe : ''
}
