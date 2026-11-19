import type { DecisionKind, SessionStatus } from '@claudeswitcher/core'
import { isChoiceKind } from './request-kind.js'

/**
 * What a session's requests and status say, in the order the list's marker checks them
 * (`renderer/session-marker.ts` `statusMarker`), the first match winning:
 * - `choice`: a request the app can still decide (not released) asks for a choice (`isChoiceKind`);
 * - `yes-no`: a request the app can still decide asks for a yes or a no, or the session waits with no
 *   request of its own in the app (a Notification or registry wait);
 * - `released`: the session has requests, but the app released all of them
 *   (`PERMISSION_RELEASE_AFTER_MS`), so only the session's own prompt can decide them;
 * - `working`: the session runs (`SessionView.status`; the daemon counts an active subagent's tool
 *   too, `session-store.ts` `views`);
 * - `rest`: none of these. The list then looks further (the usage limit, the finish), the tray at
 *   the finish.
 *
 * The one home of these steps: the list's marker and the tray icon (`main/tray-state.ts`) both
 * follow it, so the two always agree.
 */
export type SessionState = 'choice' | 'yes-no' | 'released' | 'working' | 'rest'

/** The session's state from its status and its OWN pending requests (see `SessionState`). Pure. */
export function sessionState(
  status: SessionStatus,
  decisions: readonly { released: boolean; kind: DecisionKind }[],
): SessionState {
  const held = decisions.filter((decision) => !decision.released)
  if (held.some((decision) => isChoiceKind(decision.kind))) return 'choice'
  if (held.length > 0) return 'yes-no'
  if (decisions.length > 0) return 'released'
  if (status === 'waiting') return 'yes-no'
  if (status === 'working') return 'working'
  return 'rest'
}
