import { contextBridge, ipcRenderer } from 'electron'
import type { SetupApi } from './setup-api.js'

/**
 * The setup window's preload. The request channels belong to the main process's `ipcMain.handle`
 * calls in `index.ts`, `setup:changed` and `setup:captured` to its `webContents.send`. It exposes
 * nothing else: no daemon channel, so the setup page never sees the token.
 */
const api: SetupApi = {
  load: () => ipcRenderer.invoke('setup:load'),
  save: (request) => ipcRenderer.invoke('setup:save', request),
  installIntegration: () => ipcRenderer.invoke('setup:install'),
  uninstallIntegration: () => ipcRenderer.invoke('setup:uninstall'),
  setCapture: (active) => ipcRenderer.invoke('setup:capture', active),
  onCaptured: (callback) => {
    const listener = (_event: unknown, payload: unknown): void => {
      callback(payload)
    }
    ipcRenderer.on('setup:captured', listener)
    return () => {
      ipcRenderer.removeListener('setup:captured', listener)
    }
  },
  onChanged: (callback) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on('setup:changed', listener)
    return () => {
      ipcRenderer.removeListener('setup:changed', listener)
    }
  },
}

contextBridge.exposeInMainWorld('claudeswitcherSetup', api)
