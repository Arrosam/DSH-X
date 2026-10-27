import { join } from 'node:path'

/** APP_DIR 在导入业务模块时确定；macOS / Linux 不看 APPDATA，测试必须同时隔离 HOME 和配置文件位置。 */
export function isolateUserHome(root, appData = root) {
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.APPDATA = appData
  if (process.platform === 'darwin') return join(root, 'Library', 'Application Support', 'DSH')
  if (process.platform === 'linux') {
    // Linux 走 XDG_CONFIG_HOME（默认 ~/.config）；测试必须让服务端和用例写到同一个目录
    const config = process.env.XDG_CONFIG_HOME || join(root, '.config')
    process.env.XDG_CONFIG_HOME = config
    return join(config, 'DSH')
  }
  return join(appData, 'DSH')
}
