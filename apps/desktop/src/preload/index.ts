import { contextBridge, ipcRenderer } from 'electron'
import { OVERLAY_CHANNELS } from '../shared/overlay-channels.js'
import type { ClaudeSwitcherApi } from './api.js'

/**
 * The implementation of `ClaudeSwitcherApi`. The request channels belong to the handlers the main
 * process registers on `ipcMain` (main `ipc-handle.ts` `createHandleFrom`), `overlay:shown` to the
 * main process's `webContents.send` call (main `overlay-window.ts` `createOverlay`).
 */
const api: ClaudeSwitcherApi = {
  connection: () => ipcRenderer.invoke(OVERLAY_CHANNELS.connection),
  state: () => ipcRenderer.invoke(OVERLAY_CHANNELS.state),
  finishesSeen: () => ipcRenderer.invoke(OVERLAY_CHANNELS.finishesSeen),
  clearFinish: (sessionId) => ipcRenderer.invoke(OVERLAY_CHANNELS.clearFinish, sessionId),
  excludedSessions: () => ipcRenderer.invoke(OVERLAY_CHANNELS.excludedSessions),
  setExcluded: (sessionId, excluded) => ipcRenderer.invoke(OVERLAY_CHANNELS.setExcluded, sessionId, excluded),
  focusSession: (sessionId) => ipcRenderer.invoke(OVERLAY_CHANNELS.focusSession, sessionId),
  conversation: (sessionId) => ipcRenderer.invoke(OVERLAY_CHANNELS.conversation, sessionId),
  hide: () => ipcRenderer.invoke(OVERLAY_CHANNELS.hide),
  decide: (id, decision) => ipcRenderer.invoke(OVERLAY_CHANNELS.decide, id, decision),
  settings: () => ipcRenderer.invoke(OVERLAY_CHANNELS.settings),
  appVersion: () => ipcRenderer.invoke(OVERLAY_CHANNELS.appVersion),
  onShown: (callback) => {
    const listener = (_event: unknown, preferred: unknown): void => {
      callback(typeof preferred === 'string' ? preferred : undefined)
    }
    ipcRenderer.on(OVERLAY_CHANNELS.shown, listener)
    return () => {
      ipcRenderer.removeListener(OVERLAY_CHANNELS.shown, listener)
    }
  },
}

contextBridge.exposeInMainWorld('claudeswitcher', api)
