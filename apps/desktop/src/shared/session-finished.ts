import type { SessionStatus } from '@claudeswitcher/core'

/**
 * Whether a session has just finished its turn: it has a `stoppedAt` (`SessionView.stoppedAt`) and
 * neither runs nor waits. A session working again next to an old `stoppedAt` has not "finished".
 * The list's ✓ marker (`renderer/session-marker.ts`) and the tray's done mark (`main/tray-state.ts`)
 * both follow it, through `finishState`.
 */
export function hasFinished(view: { status: SessionStatus; stoppedAt?: number | undefined }): boolean {
  return view.stoppedAt !== undefined && view.status === 'idle'
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
 */
export function acknowledgeFinish(
  seen: Map<string, number>,
  session: { sessionId: string; stoppedAt?: number | undefined },
): void {
  if (session.stoppedAt !== undefined) seen.set(session.sessionId, session.stoppedAt)
}

/**
 * Whether the session has finished (`hasFinished`), and if so, whether the user has seen that
 * finish (`acknowledgeFinish`). The one rule of "seen": the tray's done mark counts the `unseen`
 * ones (`main/tray-state.ts` `trayState`), and the list shows `unseen` as a green ✓ and `seen` as a
 * blue one (`renderer/session-marker.ts` `statusMarker`), so the two always agree. One exception:
 * a turn the usage limit ended finishes too (its `StopFailure` sets `stoppedAt`), but the list
 * shows its usage limit marker instead of the ✓, while the tray still counts an unseen one.
 */
export function finishState(
  view: { sessionId: string; status: SessionStatus; stoppedAt?: number | undefined },
  seen: SeenFinishes,
): 'none' | 'unseen' | 'seen' {
  if (!hasFinished(view)) return 'none'
  return seen.get(view.sessionId) === view.stoppedAt ? 'seen' : 'unseen'
}
