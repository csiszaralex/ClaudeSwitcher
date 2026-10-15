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
})
