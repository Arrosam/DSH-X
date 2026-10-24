// 单独一个文件，是为了能在不装 Electron 的情况下验它（main.js 一上来就 require('electron')）。
// 这两件事是这个外壳的门：进不了门的地址一律不碰。

/** 只认本机回环地址：这个外壳是给 dsh 自己的页面用的，不是通用浏览器。 */
function isLocalUrl(value) {
  try {
    const url = new URL(String(value))
    return /^https?:$/.test(url.protocol) && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/** 启动参数里挑出要打开的地址（Electron 自己的开关和外壳目录一律跳过）。 */
function urlFromArgv(argv) {
  return argv.slice(1).find((arg) => isLocalUrl(arg)) || ''
}

/**
 * 标签页的身份：启动器用 `--tab=<id>` 传实例身份（环境 + 版本 + profile），
 * 不是端口——dsh 重启后端口和 token 都会变，按地址认会留下一个死标签再开一个新的。
 * 没给就返回空串，调用方退回按 origin 认。
 */
function tabKeyFromArgv(argv) {
  const flag = argv.slice(1).find((arg) => arg.startsWith('--tab='))
  return flag ? flag.slice('--tab='.length) : ''
}

module.exports = { isLocalUrl, urlFromArgv, tabKeyFromArgv }
