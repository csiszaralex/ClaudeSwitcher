import type { SessionStatus } from '@claudeswitcher/core'

/**
 * Whether a session has just finished its turn: it has a `stoppedAt` (`SessionView.stoppedAt`) and
 * neither runs nor waits. A session working again next to an old `stoppedAt` has not "finished".
 * The list's ✓ marker (`renderer/session-marker.ts`) and the tray's done mark (`main/tray-state.ts`)
 * both follow it.
 */
export function hasFinished(view: { status: SessionStatus; stoppedAt?: number | undefined }): boolean {
  return view.stoppedAt !== undefined && view.status === 'idle'
}
