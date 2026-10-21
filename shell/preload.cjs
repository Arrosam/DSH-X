/**
 * 管理页（和独立窗口的那张本地页）的预加载脚本：把 Rust 外壳里 wry 注入的 `window.ipc.postMessage`
 * 原样补上，页面（public/index.html、internal-tabs.js）不用为 Electron 改一行。
 *
 * 只给本地页面装：远端的 dsh 页面不加载这个文件，拿不到任何外壳通道（见 main.mjs 的 tabPreferences）。
 * 必须是 CommonJS：沙盒里的预加载不支持 ESM。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 和 main.mjs 的 IPC_CHANNEL 一致。 */
const IPC_CHANNEL = 'dsh-x:ipc'
/** 单条消息的上限：页面发的都是很短的 JSON，超长的直接丢，别让主进程去解析。 */
const MESSAGE_MAX_CHARS = 64 * 1024

contextBridge.exposeInMainWorld('ipc', {
  postMessage(message) {
    const text = String(message)
    if (text.length <= MESSAGE_MAX_CHARS) ipcRenderer.send(IPC_CHANNEL, text)
  },
})
