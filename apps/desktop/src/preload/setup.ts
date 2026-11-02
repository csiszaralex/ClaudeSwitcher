import { contextBridge, ipcRenderer } from 'electron'
import { SETUP_CHANNELS } from '../shared/setup-channels.js'
import type { SetupApi } from './setup-api.js'

/**
 * The setup window's preload. The request channels (`SETUP_CHANNELS`) belong to the main process's
 * `handleFrom` calls in `index.ts`, `changed` and `captured` to its `webContents.send`. It exposes
 * nothing else: no daemon channel, so the setup page never sees the token.
 */
const api: SetupApi = {
  load: () => ipcRenderer.invoke(SETUP_CHANNELS.load),
  save: (request) => ipcRenderer.invoke(SETUP_CHANNELS.save, request),
  installIntegration: () => ipcRenderer.invoke(SETUP_CHANNELS.install),
  uninstallIntegration: () => ipcRenderer.invoke(SETUP_CHANNELS.uninstall),
  setCapture: (active) => ipcRenderer.invoke(SETUP_CHANNELS.capture, active),
  onCaptured: (callback) => {
    const listener = (_event: unknown, payload: unknown): void => {
      callback(payload)
    }
    ipcRenderer.on(SETUP_CHANNELS.captured, listener)
    return () => {
      ipcRenderer.removeListener(SETUP_CHANNELS.captured, listener)
    }
  },
  onChanged: (callback) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on(SETUP_CHANNELS.changed, listener)
    return () => {
      ipcRenderer.removeListener(SETUP_CHANNELS.changed, listener)
    }
  },
}

contextBridge.exposeInMainWorld('claudeswitcherSetup', api)
