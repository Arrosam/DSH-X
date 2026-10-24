const { contextBridge, ipcRenderer } = require('electron')

// 标签条只能做这三件事，拿不到 Node，也拿不到带 token 的地址。
contextBridge.exposeInMainWorld('shellTabs', {
  onTabs: (callback) => ipcRenderer.on('tabs', (_event, list) => callback(list)),
  select: (id) => ipcRenderer.send('tab', { action: 'select', id }),
  close: (id) => ipcRenderer.send('tab', { action: 'close', id }),
  reload: () => ipcRenderer.send('tab', { action: 'reload' }),
  ready: () => ipcRenderer.send('ready'),
})
