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
   * The finishes the user has seen (main `index.ts` `finishesSeen`), as `seenFinishesReply` gives
   * them; the renderer reads them with a check (`readSeenFinishes`).
   */
  finishesSeen: 'session:finishes-seen',
  /**
   * Clears the ✓ of a session's finish (Backspace on its row, `shared/session-finished.ts`
   * `clearFinish`); the argument is the session id. Answers like `finishesSeen`, so the list
   * redraws at once.
   */
  clearFinish: 'session:clear-finish',
  /**
   * The sessions the user moved out of the list, the ones that came back because they started
   * running or because their time passed, and the weekly reset (main `excluded-sessions.ts`), as a
   * `shared/excluded-sessions.ts` `ExcludedReply`; the renderer reads it with a check
   * (`readExcludedSessions`).
   */
  excludedSessions: 'session:excluded',
  /**
   * Moves a session out of the list or brings it back (Delete on its row). The arguments are the
   * session id and `true` to exclude, `false` to bring back; the direction is explicit, so a key
   * pressed twice before the reply does the same thing twice. Answers like `excludedSessions`.
   */
  setExcluded: 'session:set-excluded',
  /**
   * Excludes a session until a time, or sets a new time for an excluded one (Shift+Delete on its
   * row, then the time bar). The arguments are the session id and the time (epoch ms), which the
   * main process refuses unless it is a finite number in the future (`excludeUntil`). Answers like
   * `excludedSessions`.
   */
  setExcludedUntil: 'session:set-excluded-until',
  /**
   * Ends the due mark of a session whose exclusion time passed (Backspace on its row); the argument
   * is the session id. Answers like `excludedSessions`.
   */
  clearDue: 'session:clear-due',
  /**
   * Pushed by the main process whenever the excluded, the returned or the due sessions change
   * without a request of the overlay (a session that came back because it started running or
   * because its time passed, a mark the first jump ended, a session gone), with the same reply as
   * `excludedSessions`.
   */
  excludedChanged: 'session:excluded-changed',
  /**
   * The sessions in the auto-accept mode and their counts (main `auto-accept.ts`), as an array of
   * `AutoAcceptEntry`; the renderer reads it with a check (`readAutoAccept`).
   */
  autoAccept: 'session:auto-accept',
  /**
   * Turns the auto-accept mode on or off for a session (the Shift+A hold on its row). The arguments
   * are the session id and `true` for on, `false` for off; the direction is explicit, as for
   * `setExcluded`. Answers like `autoAccept`.
   */
  setAutoAccept: 'session:set-auto-accept',
  /**
   * Pushed by the main process whenever the sessions in the auto-accept mode or their counts change
   * (a request allowed by the mode while the overlay shows, a session gone), with the same array as
   * `autoAccept`.
   */
  autoAcceptChanged: 'session:auto-accept-changed',
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
