/**
 * 标签条本地页（shell/strip.html）的预加载：把 wry 外壳里页面本来就有的 `window.ipc.postMessage`
 * 补上，标签条的脚本两个平台写一份。
 *
 * 只装在标签条页上：远端 dsh 页面（WebContentsView 与独立窗口）都不加载这个文件，
 * 拿不到任何外壳通道。必须是 CommonJS：沙盒里的预加载不支持 ESM。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 和 main.mjs 的 IPC_CHANNEL 一致。 */
const IPC_CHANNEL = 'dsh-x:ipc'
/** 单条消息的上限：标签条发的都是很短的 JSON，超长的直接丢，别让主进程去解析。 */
const MESSAGE_MAX_CHARS = 64 * 1024

contextBridge.exposeInMainWorld('ipc', {
  postMessage(message) {
    const text = String(message)
    if (text.length <= MESSAGE_MAX_CHARS) ipcRenderer.send(IPC_CHANNEL, text)
  },
})
