/**
 * 原生通知总开关：设置里的「任务通知」同时管 `dsh-x-desktop-notify` 的 loader 行。
 *
 * 外壳本来就按这个开关拦截 `/api/desktop/notify`；这里再把插件行一并停掉，让「关」
 * 变成插件不再监听会话事件，而不只是通知被外壳丢掉。开 = 删掉禁用块，关 = 写禁用块。
 * 不卸载包、不动依赖和别的插件开关。
 *
 * 只管装了下面两个包之一的环境：单体插件（dsh-x-desktop-notify）或桌面组
 * （dsh-x-desktop-bundle）。没装的环境不会被写上过期覆盖，以后装组也不会一上来就是停用。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { disableRowId, enableRowId } from './plugins.js'

/** 原生通知的 loader 行 id：插件自己的 patch 与桌面组 patch 用的是同一个 id。 */
export const NATIVE_NOTIFY_ROW_ID = 'x-desktop-notify'

/** 装了其中任意一个包的环境才归这个开关管。 */
export const NATIVE_NOTIFY_PACKAGES = Object.freeze(['dsh-x-desktop-notify', 'dsh-x-desktop-bundle'])

/**
 * 这个 profile 装没装原生通知（单体或组）。
 * @param {object} manifest - profile 的 package.json 内容。
 * @returns {boolean} 装了为 true。
 */
export function profileHasNativeNotify(manifest) {
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  return NATIVE_NOTIFY_PACKAGES.some((name) => Object.hasOwn(dependencies, name))
}

/**
 * 把原生通知开关落到一个 DSH_HOME 下的所有 profile。
 *
 * 单个环境读不动或补丁层写不进去（不是合法条目数组）只记失败，不影响其它环境——
 * 开关是全局动作，不能因为一个坏环境就一个都关不掉。
 *
 * @param {string} home - DSH_HOME。
 * @param {boolean} enabled - true 恢复插件行；false 停用。
 * @returns {{ home: string, changed: number, profiles: string[], failed: { profile: string, error: string }[] }} 改动结果。
 */
export function applyNativeNotify(home, enabled) {
  const result = { home, changed: 0, profiles: [], failed: [] }
  const dir = join(home, 'profiles')
  let names = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
  } catch {
    return result
  }
  for (const name of names) {
    const profileDir = join(dir, name)
    const file = join(profileDir, 'package.json')
    if (!existsSync(file)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!profileHasNativeNotify(manifest)) continue
    try {
      const outcome = enabled ? enableRowId(profileDir, NATIVE_NOTIFY_ROW_ID) : disableRowId(profileDir, NATIVE_NOTIFY_ROW_ID)
      if (outcome.changed) {
        result.changed += 1
        result.profiles.push(name)
      }
    } catch (error) {
      result.failed.push({ profile: name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
