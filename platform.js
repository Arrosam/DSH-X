/**
 * 平台常量：名字、文件名这类「写死就对了」的东西，打包脚本和运行时共用一份。
 *
 * 行为（每用户目录在哪、外壳在哪、怎么弹对话框、怎么打开目录……）不在这里，
 * 在 filemanager.js 选出来的实现类里——这边只留纯常量，是为了让打包脚本能在
 * 任何一台机器上 import 它（pack-mac.mjs 要 MAC_* 这些名字），不被平台判断牵连。
 */

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** 自带运行时里 node 的文件名。两个平台都是扁平布局：<安装目录>/node/<它>，npm/pnpm 在同目录的 node_modules 里。 */
export const NODE_BINARY = IS_WINDOWS ? 'node.exe' : 'node'

/** 每用户目录的名字（settings.json、manager.log、webview 数据都在它下面；Rust 外壳里有同名常量）。 */
export const APP_DIR_NAME = 'DSH'

/** macOS 包的名字和 bundle id：Info.plist、LaunchAgent、自更新都认它们。 */
export const MAC_APP_NAME = 'DSH-X.app'
export const MAC_BUNDLE_ID = 'io.github.yyh-001.dsh-x'
/** 外壳可执行文件名（Cargo.toml 的 [[bin]] name）。 */
export const LAUNCHER_NAME = 'DSH'
