/**
 * DSH-X 桌面增强：随启动器自动装进 web profile 的三个首方插件。
 *
 * 它们是普通的 dsh 插件（host / client 分开），只有装进 profile 才会加载。启动器在每次
 * 拉起实例前检查一遍，缺哪个就补哪个；装法复用插件页那条链路（`dsh plugin add` + 写
 * `dsh.profile.bundles`），所以从 npm 装、能在插件页更新。
 *
 * 只看「装没装」，不看行是否启用：用户在 dsh 插件页关掉的插件不会被这里重新打开。
 *
 * 纯函数（不读盘、不起进程），单测见 test/desktop-plugins.test.mjs；真正的安装留在
 * server.js 的 addPlugin。
 */

/**
 * 三个首方插件。
 *
 * `spec` 钉精确版本：核心的 safeSpec 不接受 `^`；也不用 `latest`——新包首发会先出一个
 * `0.0.0-stage` 占位版本，`@latest` 在那段时间装到的是空壳。升级交给插件页（它按
 * registry 上的最新版本 add），这里只负责把缺的装上。
 *
 * `minDsh` 是插件 dsh.compatibility.dsh 的下限；同一版本的预发布（0.2.1-rc.4）算满足。
 */
export const DESKTOP_PLUGINS = Object.freeze([
  { name: 'dsh-x-desktop-notify', spec: '0.1.1', label: '原生通知', minDsh: '0.2.0' },
  { name: 'dsh-x-context-menu', spec: '0.1.1', label: '右键菜单', minDsh: '0.2.0' },
  { name: 'dsh-x-sidebar-browser', spec: '0.1.1', label: '侧栏浏览器控制', minDsh: '0.2.1-rc.2' },
])

/** dsh 自己的 desktop profile 归 dsh-desktop 管，DSH-X 不往里塞插件（同 --patch 的例外）。 */
export const DESKTOP_PLUGINS_SKIP_PROFILES = Object.freeze(['desktop'])

/**
 * `x.y.z` / `x.y.z-rc.1` → `[x, y, z]`；认不出来返回 null。
 * @param {string} text - dsh 版本。
 * @returns {number[] | null} 主次修订三个数字。
 */
export function parseDshVersion(text) {
  const match = String(text ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 版本够不够插件要求的下限。
 *
 * 只比主次修订：同一版本的预发布（`0.2.1-rc.4` 对 `0.2.1-rc.2`）算满足——插件的
 * compatibility 写的是「从哪个版本开始有这些接口」，预发布同样有。
 *
 * @param {string} version - 要启动的 dsh 版本。
 * @param {string} min - 插件要求的最低版本。
 * @returns {boolean} 够不够；任一边认不出来都算不够（宁可不装，也不装坏一个 profile）。
 */
export function versionAtLeast(version, min) {
  const left = parseDshVersion(version)
  const right = parseDshVersion(min)
  if (!left || !right) return false
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return true
    if (left[i] < right[i]) return false
  }
  return true
}

/**
 * 这个 dsh 版本能装的桌面增强插件。
 * @param {string} version - 要启动的 dsh 版本。
 * @returns {{ name: string, spec: string, label: string, minDsh: string }[]} 子集。
 */
export function desktopPluginsForDsh(version) {
  return DESKTOP_PLUGINS.filter((plugin) => versionAtLeast(version, plugin.minDsh))
}

/**
 * profile 还缺哪些桌面增强插件。
 *
 * 已经写在 `dependencies` 里就算装了（不管是 registry 版本、`link:` 还是 `file:`）：
 * 开发机上 link 的本地包不该被换成 npm 版。
 *
 * @param {object} manifest - profile 的 package.json 内容。
 * @param {string} version - 要启动的 dsh 版本。
 * @returns {{ name: string, spec: string, label: string, minDsh: string }[]} 需要安装的插件。
 */
export function desktopPluginsToInstall(manifest, version) {
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  return desktopPluginsForDsh(version).filter((plugin) => !Object.hasOwn(dependencies, plugin.name))
}
