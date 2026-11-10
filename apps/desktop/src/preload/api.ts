import type { UserDecision } from '@claudeswitcher/core'

interface DaemonConnection {
  port: number
  token: string
}

/**
 * The API exposed to the renderer, in a single declaration. The preload's `api` object implements
 * it, and it is the type of the renderer's `window.claudeswitcher` (see `renderer/window-api.ts`).
 * It lives in its own file because the preload imports the `electron` module, whose types would
 * pull the Node types into the renderer's type check. Whatever returns `unknown`, the renderer
 * reads with a check.
 */
export interface ClaudeSwitcherApi {
  connection: () => Promise<DaemonConnection>
  /** The daemon's state; the renderer reads it with `sanitizeState`. */
  state: () => Promise<unknown>
  focusSession: (sessionId: string) => Promise<boolean>
  hide: () => Promise<void>
  /** The main process gives the reply as a `DecideResult`; the renderer reads it with a check. */
  decide: (id: string, decision: UserDecision) => Promise<unknown>
  /** The main process gives `{ hideAfterLastDecision }`; the renderer reads it with a check (`readOverlaySettings`). */
  settings: () => Promise<unknown>
  /**
   * Subscribes to the overlay's appearance; the returned function unsubscribes. The renderer gets
   * only its own callback, not the `IpcRendererEvent`: through that `ipcRenderer` would be reachable.
   */
  onShown: (callback: () => void) => () => void
}
