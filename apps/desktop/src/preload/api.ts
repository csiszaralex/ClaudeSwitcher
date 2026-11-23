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
  /**
   * The finishes the user has seen (`seenFinishesReply`); the renderer reads them with
   * `readSeenFinishes`.
   */
  finishesSeen: () => Promise<unknown>
  /** Clears the ✓ of the session's finish; answers like `finishesSeen`. */
  clearFinish: (sessionId: string) => Promise<unknown>
  /**
   * The sessions moved out of the list and the ones that came back because they started running;
   * the renderer reads them with `readExcludedSessions`.
   */
  excludedSessions: () => Promise<unknown>
  /** Moves the session out of the list (`true`) or brings it back (`false`); answers like `excludedSessions`. */
  setExcluded: (sessionId: string, excluded: boolean) => Promise<unknown>
  /**
   * Subscribes to the main process's push of the excluded sessions (answered like
   * `excludedSessions`); the returned function unsubscribes. As with `onShown`, the callback gets
   * only the payload.
   */
  onExcludedChanged: (callback: (raw: unknown) => void) => () => void
  /** The sessions in the auto-accept mode and their counts; the renderer reads them with `readAutoAccept`. */
  autoAccept: () => Promise<unknown>
  /** Turns the auto-accept mode on (`true`) or off (`false`) for the session; answers like `autoAccept`. */
  setAutoAccept: (sessionId: string, on: boolean) => Promise<unknown>
  /**
   * Subscribes to the main process's push of the auto-accept sessions (answered like `autoAccept`);
   * the returned function unsubscribes. As with `onShown`, the callback gets only the payload.
   */
  onAutoAcceptChanged: (callback: (raw: unknown) => void) => () => void
  focusSession: (sessionId: string) => Promise<boolean>
  /**
   * The session's recent conversation; the main process gives a `ConversationReply`, the renderer
   * reads it with a check (`readConversationReply`).
   */
  conversation: (sessionId: string) => Promise<unknown>
  hide: () => Promise<void>
  /** The main process gives the reply as a `DecideResult`; the renderer reads it with a check. */
  decide: (id: string, decision: UserDecision) => Promise<unknown>
  /** The main process gives `{ hideAfterLastDecision }`; the renderer reads it with a check (`readOverlaySettings`). */
  settings: () => Promise<unknown>
  /** The main process gives this app's version as a string; the renderer reads it with a check (`readAppVersion`). */
  appVersion: () => Promise<unknown>
  /**
   * Subscribes to the overlay's appearance; the returned function unsubscribes. The renderer gets
   * only its own callback, not the `IpcRendererEvent`: through that `ipcRenderer` would be reachable.
   * The callback gets the session id the main process asked to select (a clicked notification), or
   * `undefined`; the preload passes it on only if it is a string.
   */
  onShown: (callback: (preferredSessionId: string | undefined) => void) => () => void
}
