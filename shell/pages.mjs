/**
 * 外壳自己画的本地页（data: URL）：不依赖管理服务在不在。文案与样式照搬已删的 Rust 外壳
 * （launcher/main.rs 的 IDLE_PAGE、tabs.rs 的停止页，git 历史可查），两个平台看到的一样。
 *
 * Electron 标签窗口只保留一张：实例停了之后标签 / 独立窗口里显示的停止页（#58 的主题跟随）。
 * 启动失败不再画错误窗口——那是原生外壳的职责，Electron 这边把原因写到 stderr 就退出。
 */

export function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/**
 * 实际生效的深色状态：显式 light/dark 说了算；system（以及将来新增的未知值）跟随系统。
 * 和已删的 launcher/tabs.rs 的 resolve_dark 一致（#58）。
 */
export function resolveDark(theme, systemDark) {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return systemDark
}

/**
 * 标签页对应的实例停了：不在旧端口上反复刷新，以免重启间隙误加载到另一个实例。
 * 深色沿用旧外壳 idle 页的配色（底色 #15171c、文字 #b9bec9）：同一个窗口里不该有两种黑。
 */
export function stoppedPage(lang, dark) {
  const text = lang === 'en' ? 'This DSH instance has stopped. Return to the launcher to start it.' : '此 DSH 实例已停止，请返回启动器启动。'
  const [color, background] = dark ? ['#b9bec9', '#15171c'] : ['#7182a2', '#f5f8ff']
  return `<!doctype html><meta charset='utf-8'><style>body{font:16px system-ui;color:${color};background:${background};display:grid;place-items:center;height:90vh}</style><p>${text}</p>`
}
