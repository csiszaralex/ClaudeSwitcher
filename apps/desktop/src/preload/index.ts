import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudeSwitcherApi } from './api.js'

/**
 * A `ClaudeSwitcherApi` megvalósítása. A kérések csatornái a main `ipcMain.handle` hívásaihoz
 * tartoznak, az `overlay:shown` a main `webContents.send` hívásához.
 */
const api: ClaudeSwitcherApi = {
  connection: () => ipcRenderer.invoke('daemon:connection'),
  state: () => ipcRenderer.invoke('daemon:state'),
  focusSession: (sessionId) => ipcRenderer.invoke('session:focus', sessionId),
  hide: () => ipcRenderer.invoke('overlay:hide'),
  decide: (id, decision) => ipcRenderer.invoke('decision:decide', id, decision),
  settings: () => ipcRenderer.invoke('settings:get'),
  onShown: (callback) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on('overlay:shown', listener)
    return () => {
      ipcRenderer.removeListener('overlay:shown', listener)
    }
  },
}

contextBridge.exposeInMainWorld('claudeswitcher', api)
