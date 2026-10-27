import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/**
 * Windows（pack.mjs）和 macOS（pack-mac.mjs）两套打包共用的部分：
 * 编译原生外壳、拷哪些文件、Node 运行时的 JS 包从哪来。
 *
 * 安装包**不带运行时**：Node 由原生外壳首次运行时下载到数据目录，Electron 由服务按需下载。
 * 但 app 层仍要带 npm / pnpm 的 JS 包（见 copyNpmModules / copyPnpm 的理由），所以打包时
 * 还得下载一份 Node 发行包，只是只抄其中的 JS 包、不抄 node 本体。
 */

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Node / Electron 的版本号和压缩包 sha256 只有 runtime-versions.json 一份：原生外壳首次运行
 * 下载 Node、服务按需下载 Electron 都读它。打包脚本只取 Node 版本（见上）。
 */
function readRuntimeVersions() {
  const file = join(ROOT, 'runtime-versions.json')
  if (!existsSync(file)) throw new Error(`缺少 ${file}：外壳下载 Node、服务下载 Electron 都靠这份版本表`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export const RUNTIMES = readRuntimeVersions()
export const NODE_VERSION = RUNTIMES.node.version
/** 当前平台的 Node 发行包文件名（打包时下载它，只为了抄里面的 npm / pnpm JS 包）。 */
export function nodeArchiveFile(platform = `${process.platform}-${process.arch}`) {
  const entry = RUNTIMES.node[platform]
  if (!entry?.file) throw new Error(`runtime-versions.json 里没有 ${platform} 的 Node 发行包`)
  return entry.file
}

// 便携目录兜底的那份 pnpm：要读得动现代 profile —— lockfile 9.0、pnpm-workspace.yaml
// 里的设置（后者 pnpm 10.6 起才认）。store 主版本也跟着 pnpm 主版本走（8→v3、10→v10、
// 11/12→v11），8.x 那份拿到 v11 store 的 profile 上会以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切安装。
const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '11.27.1'
export const VENDOR = join(ROOT, 'vendor')
export const NODE_MIRRORS = [
  'https://npmmirror.com/mirrors/node',
  'https://nodejs.org/dist',
]

/**
 * 文件管理的实现类按平台分开打包：装到哪台机器上就只带哪一套。
 * filemanager.js 用动态 import 挑实现，所以另一套不在安装目录里也不会报模块找不到。
 */
const FILE_MANAGERS = {
  win32: 'filemanager-windows.js',
  darwin: 'filemanager-mac.js',
}

/** 启动器自己的源码文件（安装目录顶层）。 */
const APP_FILES = [
  'start.js',
  'server.js',
  'startup-diagnosis.js',
  'runtime-diagnostics.mjs',
  'repair-plan.js',
  'diagnostic-repair.js',
  'repair-actions.js',
  'repair-probe.mjs', 'optional-analytics-proof.js', 'repair-evidence.js',
  'repair-dependencies.js', 'repair-uninstall.mjs',
  'configuration-evidence.js', 'diagnostic-command-error.js',
  'log-writer.js',
  'registry.js',
  'settings.js',
  'proxy.js',
  'platform.js',
  'filemanager.js',
  'filemanager-base.js',
  'plugins.js',
  'recovery.js',
  'packs.js',
  'pack-market.js',
  'zip.js',
  'mcp.js',
  'skills.js',
  'sync.js',
  'version.js',
  'zipfile.js',
  'app-update.js',
  'apply-update.mjs',
  // 按需下载 Electron 运行时（服务端行为，读 runtime-versions.json）
  'runtime-download.js',
  'plugin-tool.js',
  'reserved-profile-boot.mjs',
  'stdio-unblock.cjs',
  // 服务下载 Electron 运行时、设置页显示运行时版本都要读它；外壳下载 Node 也读同一份
  'runtime-versions.json',
  'package.json',
]
// 不装进安装包的 public 素材（文件留在仓库里备回滚；要重新启用就从这份名单去掉）
const SKIP_PUBLIC = new Set([
  'head-v2.png', 'accessories-v2.png', 'ear.png',
  // v3 设计稿仅供回看；运行时使用 v8 / v9，不把旧图带进安装包
  'head-v3.png', 'tuft-v3.png', 'bow-v3.png',
  // v7 换装（docs/mascot-design/compose-v7.py）后退役的原版素材
  'base.png', 'base-dark.png', 'base-dark-soft.png', 'tuft.svg', 'tuft-dark.svg', 'bow.svg', 'bow-dark.svg',
  // v8 排布（docs/mascot-design/prepare-v8.py）后退役的 v7 均匀倍率版
  'head-v7.png', 'tuft-v7.png', 'bow-v7.png', 'ear-v7.png',
])

export function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

/**
 * cargo 的位置：rustup 默认装在 ~/.cargo/bin，而它不保证在 PATH 上（macOS 的
 * 图形化终端里就没有）；CI 的 runner 则是 PATH 上直接有。两处都找一遍。
 */
export function cargoExecutable() {
  const home = process.env.CARGO_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.cargo')
  const fileName = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const candidates = [join(home, 'bin', fileName), join(process.env.USERPROFILE || '', '.cargo', 'bin', fileName)]
  const existing = candidates.find((path) => path && existsSync(path))
  if (existing) return existing
  const probe = spawnSync(fileName, ['--version'], { encoding: 'utf8', windowsHide: true })
  if (probe.status === 0) return fileName
  throw new Error('找不到 cargo：装 Rust 工具链（rustup），或把 ~/.cargo/bin 加进 PATH')
}

/**
 * 编译原生外壳（launcher/ 的 Rust 二进制）。两个平台同一个 bin 名，产物在
 * launcher/target/release/DSH(.exe)——安装根目录 / .app 的 MacOS 目录都用它。
 */
export function buildShellBinary() {
  console.log('编译原生外壳（cargo build --release --bin DSH）')
  run(cargoExecutable(), ['build', '--release', '--bin', 'DSH'], join(ROOT, 'launcher'))
  const binary = join(ROOT, 'launcher', 'target', 'release', process.platform === 'win32' ? 'DSH.exe' : 'DSH')
  if (!existsSync(binary)) throw new Error(`cargo 没生成 ${binary}（检查 launcher/Cargo.toml 里 [[bin]] name = "DSH"）`)
  return binary
}

export async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${url}`)
  await pipeline(res.body, createWriteStream(dest))
}

/** 依次试各个镜像下载 node 发行包的某个文件。 */
export async function downloadNodeFile(file, dest) {
  let last
  for (const mirror of NODE_MIRRORS) {
    const url = `${mirror}/v${NODE_VERSION}/${file}`
    try {
      console.log(`下载 ${url}`)
      await download(url, dest)
      return
    } catch (error) {
      last = error
    }
  }
  throw last
}

/**
 * 把启动器的源码和静态资源拷进 out（原生外壳由各平台自己放）。
 *
 * app 层同时是「服务代码（原生外壳用下载的 node 跑 start.js）」和「Electron 标签窗口的
 * 应用目录（外壳按需下载的 Electron 启动 `<app 目录>` 时从 package.json 的 main 找入口）」。
 * 仓库根的 main 已经指向 shell/main.mjs（`npm start` 是显式 `node start.js`，不读 main；
 * 这样开发态直接拿仓库根当 Electron 应用目录也能起标签窗口）；这里仍显式写一遍，
 * 是盯住装进包里的那份必须指向 Electron 入口——原生外壳直接跑 start.js、不看这个字段。
 */
export async function copyAppFiles(out, platform = process.platform) {
  await mkdir(join(out, 'public'), { recursive: true })
  await mkdir(join(out, 'assets'), { recursive: true })
  const fileManager = FILE_MANAGERS[platform]
  if (!fileManager) throw new Error(`没有 ${platform} 的文件管理实现：照 filemanager-base.js 的契约补一个再打包`)
  for (const file of [...APP_FILES, fileManager]) {
    await copyFile(join(ROOT, file), join(out, file))
  }
  await cp(join(ROOT, 'public'), join(out, 'public'), {
    recursive: true,
    filter: (src) => !SKIP_PUBLIC.has(basename(src)),
  })
  await cp(join(ROOT, 'assets'), join(out, 'assets'), { recursive: true })
  await cp(join(ROOT, 'perf'), join(out, 'perf'), { recursive: true })
  await cp(join(ROOT, 'compat'), join(out, 'compat'), { recursive: true })
  // 整合包配方（packs/）：随安装包发，插件页的「内置整合包」就地安装，不用联网去 Release 拿。
  // 插件本身不随包发（仓库的 plugins/ 只是源码与发布源，插件都从 npm 装）。
  await cp(join(ROOT, 'packs'), join(out, 'packs'), { recursive: true })
  // Electron 标签窗口的宿主代码：按需下载的 Electron 用 `Electron <app 目录>` 启动它
  await cp(join(ROOT, 'shell'), join(out, 'shell'), { recursive: true })
  const pkgPath = join(out, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  await writeFile(pkgPath, `${JSON.stringify({ ...pkg, main: 'shell/main.mjs' }, null, 2)}\n`)
}

/**
 * 把 npm 从解压好的 node 发行包拷进 nodeDir/node_modules。
 *
 * 只拷 npm 的 JS 包、不拷 node 本体：Node 由原生外壳首次运行时下载到数据目录
 * （数据目录可写，不会把签名好的 .app / Program Files 写坏）。npm 必须随 app 走，
 * 因为 registry.js 在找不到 npm 时会下载到自己目录里——那正是不能发生的事。
 */
export async function copyNpmModules(modulesSrc, nodeDir) {
  await mkdir(join(nodeDir, 'node_modules'), { recursive: true })
  await cp(join(modulesSrc, 'npm'), join(nodeDir, 'node_modules', 'npm'), { recursive: true })
}

/**
 * `dsh plugin` 是 pnpm 的透传器，PATH 上没有 pnpm 就完全装不了插件。机器上有没有全局
 * pnpm 全看运气，所以便携目录自带一个，启动器再把它加进子进程 PATH。
 * 命令行包装（pnpm / pnpm.cmd）由各平台自己写——它们要调用 PATH 上的 node（运行时那份），
 * 而不是安装包里某个固定的 node 路径。
 *
 * npmCli 是用来装 pnpm 的 npm-cli.js；pnpm 是纯 JS 包，在哪个平台装出来都一样。
 */
export async function copyPnpm(nodeDir, npmCli) {
  const target = join(nodeDir, 'node_modules', 'pnpm')
  if (pnpmVersionOf(target) === PNPM_VERSION) return
  const staging = join(VENDOR, 'pnpm')
  const staged = join(staging, 'node_modules', 'pnpm')
  if (pnpmVersionOf(staged) !== PNPM_VERSION) {
    console.log(`下载 pnpm@${PNPM_VERSION}`)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: 'pnpm-bootstrap',
      private: true,
      dependencies: { pnpm: PNPM_VERSION },
    }, null, 2))
    await rm(staged, { recursive: true, force: true })
    run(process.execPath, [npmCli, 'install',
      '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund'], staging)
  }
  // 整目录替换：合并拷贝会把上一个版本的残留文件（pnpm 11 起 dist 是分块的）留在里面
  await rm(target, { recursive: true, force: true })
  await cp(staged, target, { recursive: true })
}

/**
 * 目录里那份 pnpm 的版本，没有或读不出来就是空串。判定看版本号、不看文件在不在 ——
 * 否则换了版本常量，缓存里那份旧的还会被继续发出去。
 */
function pnpmVersionOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}
