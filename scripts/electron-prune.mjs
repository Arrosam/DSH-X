import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Electron 运行时瘦身：砍掉用不上的东西再打包。
 *
 * 为什么值得做：Electron 44（Chromium 141）自带的 locale.pak 从「每种语言一份」变成
 * 「每种语言 × 语法性别（FEMININE/MASCULINE/NEUTER）」——mac 包里 .lproj 有 659 个目录、
 * 约 48 MB，而我们的界面只有中文和英文；另外 libvk_swiftshader 是「没有 GPU 时用 CPU 跑
 * Vulkan」的兜底，mac 上正常机器都有 Metal，只有极端环境（部分虚拟机、强制禁用 GPU）才用得到。
 * 两项加起来约 64 MB（未压缩），dmg 大概能小 25 MB 上下。
 *
 * 和 asar / 裁 node_modules 不同，这里只动 Electron 自己的资源，不碰 app 目录：
 * 多语言缺了就回落到英文，软件渲染缺了只是极端环境下起不来（需要时用
 * DSH_MAC_KEEP_SWIFTSHADER=1 打包保留）。
 */

/** 界面语言白名单：英文（含 en_GB 等变体）和简体中文。 */
const KEPT_LOCALES = new Set(['en', 'zh_CN'])

/** 从 .lproj / locale.pak 的文件名判断要不要留。 */
export function keepLocale(name) {
  const base = name.replace(/\.lproj$/i, '')
  if (KEPT_LOCALES.has(base)) return true
  // 英文的地区变体（en_GB、en_FEMININE…）都很小，一起留着，避免系统语言是英式英语时菜单变中文
  return base.startsWith('en_')
}

function pathSize(target) {
  let size = 0
  try {
    const info = statSync(target)
    if (!info.isDirectory()) return info.size
    for (const entry of readdirSync(target)) size += pathSize(join(target, entry))
  } catch {
    // 路径不存在/读不了就当 0：裁剪是尽力而为，不能因为它让打包失败
  }
  return size
}

function remove(target) {
  if (!existsSync(target)) return 0
  const size = pathSize(target)
  rmSync(target, { recursive: true, force: true })
  return size
}

/** 删掉目录里不认识的 .lproj（Chromium / Electron 的多语言资源）。返回省下的字节数。 */
export function pruneLocales(dir) {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith('.lproj') || keepLocale(entry)) continue
    removed += remove(join(dir, entry))
  }
  return removed
}

/**
 * macOS：Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A 下的
 * Resources/*.lproj 与 Libraries/libvk_swiftshader.dylib。
 * 只在签名之前调用（签名后改内容会让签名失效）。
 */
export function pruneMacElectron(appRoot, { keepSwiftshader = process.env.DSH_MAC_KEEP_SWIFTSHADER === '1' } = {}) {
  const framework = join(appRoot, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A')
  let removed = pruneLocales(join(framework, 'Resources'))
  if (!keepSwiftshader) {
    removed += remove(join(framework, 'Libraries', 'libvk_swiftshader.dylib'))
    removed += remove(join(framework, 'Libraries', 'vk_swiftshader_icd.json'))
  }
  // packager 正常情况下会删掉这个占位应用，出现就顺手清掉
  removed += remove(join(appRoot, 'Contents', 'Resources', 'default_app.asar'))
  return removed
}
