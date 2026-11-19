import type { SessionStatus } from '@claudeswitcher/core'
import { recipientsOf, type LinkedSession } from './prompt-links.js'

/** The part of a session the finish rules read; the daemon's `SessionView` fits it. */
export interface FinishView {
  sessionId: string
  status: SessionStatus
  stoppedAt?: number | undefined
  messagingSocketPath?: string | undefined
}

/** The session's turn has ended: it has a `stoppedAt` (`SessionView.stoppedAt`) and neither runs nor waits. */
function stoppedIdle(view: FinishView): boolean {
  return view.stoppedAt !== undefined && view.status === 'idle'
}

/**
 * The sessions a session waits on: while its own turn has ended (`stoppedIdle`), the other live
 * sessions that still work on a message it sent them (`recipientsOf`, by name). Empty otherwise. A
 * session that waits on any has not finished (`hasFinished`): its turn often only says "handed
 * over". When the last of them goes idle, the session is finished again with its unchanged
 * `stoppedAt`.
 */
export function waitsOn<S extends LinkedSession>(view: FinishView, sessions: readonly S[]): S[] {
  return stoppedIdle(view) ? recipientsOf(view, sessions) : []
}

/**
 * Whether a session has just finished its turn: it has a `stoppedAt` (`SessionView.stoppedAt`),
 * neither runs nor waits, and waits on no other session (`waitsOn`; `sessions` are all the live
 * sessions). A session working again next to an old `stoppedAt` has not "finished". The list's ✓
 * marker (`renderer/session-marker.ts`), the tray's done mark (`main/tray-state.ts`) and the
 * seen-elsewhere watch (`main/seen-elsewhere.ts`) follow it through `finishState`, and the finish
 * toast (`main/notifier.ts`) through `waitsOn`.
 */
export function hasFinished(view: FinishView, sessions: readonly LinkedSession[]): boolean {
  return stoppedIdle(view) && waitsOn(view, sessions).length === 0
}

/** The finishes the user has seen (`acknowledgeFinish`): session id to the `stoppedAt` seen. */
export type SeenFinishes = ReadonlyMap<string, number>

/**
 * Records that the user has seen a session's finish: `main/index.ts` calls it whenever the user
 * opens the session from the overlay (`focusSession`), whether or not a window came to the front,
 * and when the session's VS Code tab stayed in front (`main/seen-elsewhere.ts` `createSeenWatch`).
 * Per session and `stoppedAt`: the next finish of the session has a new `stoppedAt`, so it counts as
 * unseen again. A new turn clears the finish anyway, since `stoppedAt` goes. A `stoppedAt` that
 * disappears while a subagent runs comes back with the same value, which stays seen, so entries are
 * never pruned (one number per session id, in memory only, as the daemon's `stoppedAt` itself).
 *
 * A session that waits on others (`waitsOn`) is no finish to acknowledge: opening it then records
 * nothing, so when the last recipient goes idle its finish shows as unseen.
 */
export function acknowledgeFinish(
  seen: Map<string, number>,
  session: FinishView,
  sessions: readonly LinkedSession[],
): void {
  if (session.stoppedAt !== undefined && waitsOn(session, sessions).length === 0) seen.set(session.sessionId, session.stoppedAt)
}

/**
 * Whether the session has finished (`hasFinished`, `sessions` being all the live sessions), and if
 * so, whether the user has seen that finish (`acknowledgeFinish`). The one rule of "seen": the
 * tray's done mark counts the `unseen` ones (`main/tray-state.ts` `trayState`), and the list shows
 * `unseen` as a green ✓ and `seen` as a blue one (`renderer/session-marker.ts` `statusMarker`), so
 * the two always agree. One exception: a turn the usage limit ended finishes too (its `StopFailure`
 * sets `stoppedAt`), but the list shows its usage limit marker instead of the ✓, while the tray
 * still counts an unseen one.
 */
export function finishState(
  view: FinishView,
  seen: SeenFinishes,
  sessions: readonly LinkedSession[],
): 'none' | 'unseen' | 'seen' {
  if (!hasFinished(view, sessions)) return 'none'
  return seen.get(view.sessionId) === view.stoppedAt ? 'seen' : 'unseen'
}
