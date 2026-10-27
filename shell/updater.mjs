// 外壳/Electron 的自更新：electron-updater（NSIS / dmg）。
//
// 核心（resources/app）由 npm 通道更新；这里只管安装包本身——Electron 版本、
// 外壳窗口/托盘/更新器代码。状态通过 host 暴露给管理页，进度走 SSE shellUpdate 事件。

import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { NPM_MODE } from '../platform.js'

const { autoUpdater } = electronUpdater

/**
 * @param {object} options
 * @param {() => Promise<void>} [options.onBeforeInstall] 安装前收尾（停 dsh、关服务）
 */
export function createUpdater({ onBeforeInstall } = {}) {
  const enabled = !NPM_MODE && (app.isPackaged || Boolean(process.env.DSH_UPDATE_FEED))
  const state = {
    status: enabled ? 'idle' : 'disabled',
    current: app.getVersion(),
    latest: '',
    progress: null,
    error: '',
  }
  const listeners = new Set()
  const snapshot = () => ({ ...state, progress: state.progress ? { ...state.progress } : null })
  const emit = () => {
    const value = snapshot()
    for (const listener of listeners) {
      try { listener(value) } catch { /* 页面不在也不影响更新 */ }
    }
  }
  if (enabled) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    if (process.env.DSH_UPDATE_FEED) {
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DSH_UPDATE_FEED })
    }
    autoUpdater.on('checking-for-update', () => { state.status = 'checking'; state.error = ''; emit() })
    autoUpdater.on('update-available', (info) => { state.status = 'available'; state.latest = String(info?.version || ''); emit() })
    autoUpdater.on('update-not-available', () => { state.status = 'current'; state.latest = ''; emit() })
    autoUpdater.on('download-progress', (progress) => {
      state.status = 'downloading'
      state.progress = {
        percent: Number(progress?.percent) || 0,
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
      }
      emit()
    })
    autoUpdater.on('update-downloaded', (info) => {
      state.status = 'ready'
      state.latest = String(info?.version || state.latest)
      state.progress = { percent: 100, transferred: state.progress?.total || 0, total: state.progress?.total || 0 }
      emit()
    })
    autoUpdater.on('error', (error) => {
      state.status = 'error'
      state.error = error?.message || String(error)
      emit()
    })
  }

  return {
    state: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async check() {
      if (!enabled) return snapshot()
      state.status = 'checking'
      state.error = ''
      emit()
      try {
        await autoUpdater.checkForUpdates()
      } catch (error) {
        state.status = 'error'
        state.error = error?.message || String(error)
        emit()
      }
      return snapshot()
    },
    async download() {
      if (!enabled) return snapshot()
      if (state.status === 'ready') return snapshot()
      try {
        await autoUpdater.downloadUpdate()
      } catch (error) {
        state.status = 'error'
        state.error = error?.message || String(error)
        emit()
      }
      return snapshot()
    },
    async install() {
      if (!enabled || state.status !== 'ready') return false
      if (onBeforeInstall) await onBeforeInstall()
      // 静默安装并自动拉起新版；before-quit 里已经放行（调用方负责置 quitting）
      autoUpdater.quitAndInstall(true, true)
      return true
    },
  }
}
