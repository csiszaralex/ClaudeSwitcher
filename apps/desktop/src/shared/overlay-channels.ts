import type { ConversationEntry } from '@claudeswitcher/core'
import type { Daemon } from '@claudeswitcher/daemon'

/**
 * The overlay's IPC channels: the main process handles the requests and sends `shown`, the overlay
 * preload (`preload/index.ts`) invokes and listens. Only a type import here: the preload bundles
 * this module, and the setup preload must never import it (a chunk shared by the two preloads
 * would not load in a sandboxed preload).
 */
export const OVERLAY_CHANNELS = {
  connection: 'daemon:connection',
  state: 'daemon:state',
  /**
   * The finishes the user has seen (main `index.ts` `finishesSeen`), as `[sessionId, stoppedAt]`
   * pairs; the renderer reads them with a check (`readSeenFinishes`).
   */
  finishesSeen: 'session:finishes-seen',
  decide: 'decision:decide',
  focusSession: 'session:focus',
  /**
   * A session's recent conversation for the peek (main `conversation-reader.ts`), as a
   * `ConversationReply`; the renderer reads it with a check (`readConversationReply`).
   */
  conversation: 'session:conversation',
  hide: 'overlay:hide',
  settings: 'settings:get',
  /** This app's version (main `app.getVersion()`); the renderer reads it with a check (`readAppVersion`). */
  appVersion: 'app:version',
  /**
   * Pushed by the main process when the overlay window is shown. The optional argument is the
   * session id to select (a clicked notification); the renderer reads it with a check.
   */
  shown: 'overlay:shown',
} as const

/** The reply to `decide`: the daemon's `DecideResult`, which the renderer reads with a check. */
export type DecideOutcome = ReturnType<Daemon['decide']>

/**
 * The reply to `conversation`. `version` changes whenever the transcript does (its size and last
 * write), so the renderer can skip an unchanged reply. `unknown-session`: no live session has the
 * id; `missing`: the session has no transcript yet; `unreadable`: reading it failed.
 */
export type ConversationReply =
  | { ok: true; version: string; entries: ConversationEntry[] }
  | { ok: false; reason: 'unknown-session' | 'missing' | 'unreadable' }
