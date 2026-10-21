import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 外壳的进程环境，必须在 platform.js / server.js 求值之前定好（main.mjs 第一个 import 的就是本文件，
 * ES 模块按 import 顺序求值）：platform.js 在加载时就按 PATH 找子进程用的 node（RUNTIME_NODE）。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 从 Finder / 程序坞打开的应用只拿到 launchd 的精简 PATH；插件的构建脚本会用到 git 之类，补上常见位置。 */
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin']

const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean)
// 自带运行时排最前（和 Rust 外壳一样）：dsh 子进程里的 node / npm / pnpm 先用随包发的那份
const bundled = join(ROOT, 'node')
if (existsSync(bundled)) dirs.unshift(bundled)
for (const extra of EXTRA_PATHS) if (!dirs.includes(extra)) dirs.push(extra)
process.env.PATH = [...new Set(dirs)].join(delimiter)

// 告诉管理服务：管理页由外壳自己的窗口承载、外壳会开内部标签页（server.js 的 shellWindowHost /
// internalTabsHost）。同进程，所以直接写自己的环境变量。
process.env.DSH_APP_WINDOW = '1'
process.env.DSH_INTERNAL_TABS = '1'
