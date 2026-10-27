import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 平台常量，外加「运行时装在哪、怎么算装好」那套推导。
 *
 * 文件管理那一摊的行为（每用户目录在哪、外壳在哪、怎么弹对话框、怎么打开目录、
 * 开机自启）不在这里，在 filemanager.js 选出来的实现类里——这边只留常量，
 * 是为了让打包脚本能在任何一台机器上 import 它，不被平台判断牵连。
 */

const ROOT = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** 管理服务是不是跑在 Electron 主进程里（过渡期的旧外壳才会，见 docs/no-electron-runtime.md）。 */
export const IN_ELECTRON = Boolean(process.versions.electron)

/**
 * 是不是打包后的安装布局：app 层放在 <安装根>/resources/app（macOS 在
 * <X>.app/Contents/Resources/app）。不再用 IN_ELECTRON 推断——服务现在由外壳拉起的
 * 独立 node 跑，Electron 只负责按需开 dsh 页面的标签窗口，两者不是一回事。
 * 源码运行（npm start，或 `DSH_APP_ROOT=$PWD launcher/target/release/DSH`）的目录不是 resources/app，算未打包。
 */
export function isPackagedAppRoot(root = ROOT) {
  return /(^|[\\/])resources[\\/]app[\\/]?$/i.test(String(root))
}

export const PACKAGED = isPackagedAppRoot(ROOT)

/** 安装根目录（Windows：<安装根>；macOS：<X>.app/Contents）；源码运行返回空串。 */
export function installRootOf(root = ROOT) {
  return isPackagedAppRoot(root) ? dirname(dirname(root)) : ''
}

/**
 * 原生外壳可执行文件的路径：Windows <安装根>/DSH.exe，macOS <X>.app/Contents/MacOS/DSH。
 * 应用层增量更新换完 resources/app 后要重新拉起它（见 apply-update.mjs）；源码运行返回空串。
 * macOS 的 .app 包名不一定是 DSH-X.app（用户可能改名），所以从目录结构反推，不写死包名。
 */
export function shellExecutable(root = ROOT, platform = process.platform, exists = existsSync) {
  const installRoot = installRootOf(root)
  if (!installRoot) return ''
  const exe = platform === 'darwin'
    ? join(installRoot, 'MacOS', LAUNCHER_NAME)
    : join(installRoot, `${LAUNCHER_NAME}.exe`)
  return exists(exe) ? exe : ''
}

/**
 * 运行时版本与压缩包哈希的单一来源：runtime-versions.json（打包脚本与 Rust 外壳读同一份）。
 * 允许读不到：文件万一没随 app 层打进去，管理页还得能起来、还能靠应用层更新把它补回来。
 */
export function loadRuntimeVersions(file = join(ROOT, 'runtime-versions.json')) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export const RUNTIME_VERSIONS = loadRuntimeVersions()
export const NODE_VERSION = String(RUNTIME_VERSIONS.node?.version || '')
/** Electron 版本钉死：dsh 的 node-addon-require-builtin 只给少数版本留了预编译。 */
export const ELECTRON_VERSION = String(RUNTIME_VERSIONS.electron?.version || '')

/** runtime-versions.json 里按 平台+架构 取条的键（darwin-arm64 / win32-x64 …）。 */
export function runtimePlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/** 在 node / electron 那一段里按当前平台挑压缩包；没有对应条目就返回 null。 */
export function runtimeArchive(section, platform = process.platform, arch = process.arch) {
  const entry = section?.[runtimePlatformKey(platform, arch)]
  if (!entry || !entry.file) return null
  return { file: String(entry.file), sha256: String(entry.sha256 || '') }
}

export function nodeArchive(platform = process.platform, arch = process.arch, versions = RUNTIME_VERSIONS) {
  return runtimeArchive(versions.node, platform, arch)
}

export function electronArchive(platform = process.platform, arch = process.arch, versions = RUNTIME_VERSIONS) {
  return runtimeArchive(versions.electron, platform, arch)
}

/**
 * 数据目录里下载好的 Electron 运行时：<APP_DIR>/runtime/electron/<版本>/。
 * 只有写完 `.ready` 才算装好（下载到一半、解压失败的半成品目录还可能是旧的），
 * 外壳与这里都只认这个标记。appDir 由调用方传：platform.js 不能 import filemanager.js
 * （filemanager.js 反过来 import 它，会成环）。
 */
export function electronRuntime(appDir, { version = ELECTRON_VERSION, platform = process.platform, arch = process.arch } = {}) {
  const dir = join(String(appDir), 'runtime', 'electron', version)
  return {
    version,
    dir,
    installed: existsSync(join(dir, '.ready')),
    // 解压后应有的可执行文件：写 .ready 之前先确认它在，免得把坏包当装好
    executable: platform === 'darwin'
      ? join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(dir, 'electron.exe'),
    download: electronArchive(platform, arch),
  }
}

/**
 * 拉子进程（dsh、npm、pnpm）用的 node。
 *
 * 原生外壳会在启动服务前把下载好的 node 路径通过 DSH_RUNTIME_NODE 传进来，这是现在的主路径。
 * 没有它时才回到旧布局：Electron 外壳里没有单独的 node 可执行文件，Electron 本体带着 Node
 * （44 起是 Node 24），子进程设 ELECTRON_RUN_AS_NODE=1 后按 node 跑，环境变量由
 * RUNTIME_NODE_ENV 补；0.1.19 及以前的安装包在 node/ 下自带过一份 node，保留 existsSync
 * 判断兼容它们。源码运行就是正在跑的这个 node。
 */
export function runtimeNode(env = process.env, root = ROOT, inElectron = IN_ELECTRON) {
  if (env.DSH_RUNTIME_NODE) return env.DSH_RUNTIME_NODE
  if (!inElectron) return process.execPath
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

/** 每用户目录的名字（settings.json、manager.log、runtime/ 都在它下面）。 */
export const APP_DIR_NAME = 'DSH'

/** macOS 包的名字和 bundle id：Info.plist、LaunchAgent、自更新都认它们。 */
export const MAC_APP_NAME = 'DSH-X.app'
export const MAC_BUNDLE_ID = 'io.github.yyh-001.dsh-x'
/** 外壳可执行文件名（Windows：DSH.exe；macOS：Contents/MacOS/DSH）。 */
export const LAUNCHER_NAME = 'DSH'
