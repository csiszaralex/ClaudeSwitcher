import { contextBridge, ipcRenderer } from 'electron'
import { OVERLAY_CHANNELS } from '../shared/overlay-channels.js'
import type { ClaudeSwitcherApi } from './api.js'

/**
 * A `ClaudeSwitcherApi` megvalósítása. A kérések csatornái a main `ipcMain.handle` hívásaihoz
 * tartoznak, az `overlay:shown` a main `webContents.send` hívásához.
 */
const api: ClaudeSwitcherApi = {
  connection: () => ipcRenderer.invoke(OVERLAY_CHANNELS.connection),
  state: () => ipcRenderer.invoke(OVERLAY_CHANNELS.state),
  focusSession: (sessionId) => ipcRenderer.invoke(OVERLAY_CHANNELS.focusSession, sessionId),
  hide: () => ipcRenderer.invoke(OVERLAY_CHANNELS.hide),
  decide: (id, decision) => ipcRenderer.invoke(OVERLAY_CHANNELS.decide, id, decision),
  settings: () => ipcRenderer.invoke(OVERLAY_CHANNELS.settings),
  onShown: (callback) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on(OVERLAY_CHANNELS.shown, listener)
    return () => {
      ipcRenderer.removeListener(OVERLAY_CHANNELS.shown, listener)
    }
  },
}

contextBridge.exposeInMainWorld('claudeswitcher', api)
