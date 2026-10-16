import { contextBridge, ipcRenderer } from 'electron'

export interface DaemonConnection {
  port: number
  token: string
}

contextBridge.exposeInMainWorld('claudeswitcher', {
  connection: (): Promise<DaemonConnection> => ipcRenderer.invoke('daemon:connection'),
  state: (): Promise<unknown> => ipcRenderer.invoke('daemon:state'),
  focusSession: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('session:focus', sessionId),
  hide: (): Promise<void> => ipcRenderer.invoke('overlay:hide'),
  // A választ a main processz `DecideResult`-ként adja; a renderer ellenőrizve olvassa.
  decide: (id: string, decision: unknown): Promise<unknown> => ipcRenderer.invoke('decision:decide', id, decision),
  // A main `{ hideAfterLastDecision }`-t ad; a renderer ellenőrizve olvassa (readOverlaySettings).
  settings: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  // Feliratkozás az overlay megjelenésére; a visszaadott függvény leiratkozik. A renderer csak a
  // saját callbackjét kapja meg, az IpcRendererEvent-et nem — azon át az ipcRenderer elérhető lenne.
  onShown: (callback: () => void): (() => void) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on('overlay:shown', listener)
    return () => {
      ipcRenderer.removeListener('overlay:shown', listener)
    }
  },
})
