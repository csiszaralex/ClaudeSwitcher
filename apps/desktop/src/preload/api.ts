import type { UserDecision } from '@claudeswitcher/core'

interface DaemonConnection {
  port: number
  token: string
}

/**
 * A renderernek kitett API, egyetlen deklarációban. A preload `api` objektuma ezt valósítja meg, a
 * renderer `window.claudeswitcher` típusa ez (lásd `renderer/window-api.ts`). Külön fájlban van,
 * mert a preload az `electron` modult importálja, annak típusai pedig a Node típusait húznák be a
 * renderer típusellenőrzésébe. Ami `unknown`-t ad, azt a renderer ellenőrizve olvassa.
 */
export interface ClaudeSwitcherApi {
  connection: () => Promise<DaemonConnection>
  /** A daemon állapota; a renderer a `sanitizeState`-tel olvassa. */
  state: () => Promise<unknown>
  focusSession: (sessionId: string) => Promise<boolean>
  hide: () => Promise<void>
  /** A választ a main processz `DecideResult`-ként adja; a renderer ellenőrizve olvassa. */
  decide: (id: string, decision: UserDecision) => Promise<unknown>
  /** A main `{ hideAfterLastDecision }`-t ad; a renderer ellenőrizve olvassa (`readOverlaySettings`). */
  settings: () => Promise<unknown>
  /**
   * Feliratkozás az overlay megjelenésére; a visszaadott függvény leiratkozik. A renderer csak a
   * saját callbackjét kapja meg, az `IpcRendererEvent`-et nem: azon át az `ipcRenderer` elérhető lenne.
   */
  onShown: (callback: () => void) => () => void
}
