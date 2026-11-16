import { PERMISSION_RELEASE_AFTER_MS, type DecisionKind, type SessionStatus } from '@claudeswitcher/core'
import { isChoiceKind } from '../shared/request-kind.js'
import { hasFinished } from '../shared/session-finished.js'

/**
 * When the tray starts to flash for a held request nobody has decided: 50 s before the release
 * (`PERMISSION_RELEASE_AFTER_MS`), so the user still has time to decide it in the app.
 */
export const PERMISSION_WARN_AFTER_MS = PERMISSION_RELEASE_AFTER_MS - 50_000

/** The part of a session the tray reads; the daemon's `SessionView` fits it. */
export interface TraySession {
  sessionId: string
  status: SessionStatus
  /** The time of the session's last `Stop`, while it has shown no new activity (`SessionView.stoppedAt`). */
  stoppedAt?: number | undefined
}

/** The part of a pending request the tray reads; the daemon's `PendingDecisionView` fits it. */
export interface TrayDecision {
  kind: DecisionKind
  /** Released by the app (`PERMISSION_RELEASE_AFTER_MS`): it can no longer be decided here. */
  released: boolean
  /** When the daemon began to hold it (ms, the daemon's clock, `Date.now()`). */
  createdAt: number
}

export interface TrayInput {
  sessions: readonly TraySession[]
  decisions: readonly TrayDecision[]
  /** The finishes the user has seen (`acknowledgeFinish`): session id to the `stoppedAt` seen. */
  acknowledged: ReadonlyMap<string, number>
  /** The current time (ms, `Date.now()`), for the age of the held requests. */
  now: number
}

/**
 * Records that the user has seen a session's finish: opening the session from the list (the jump)
 * clears its done mark on the tray. Per session and `stoppedAt`: the next finish of the session has
 * a new `stoppedAt`, so it shows again. A new turn clears the mark anyway, since `stoppedAt` goes.
 * A `stoppedAt` that disappears while a subagent runs comes back with the same value, which stays
 * acknowledged, so entries are never pruned (one number per session id, in memory only).
 */
export function acknowledgeFinish(
  acknowledged: Map<string, number>,
  session: { sessionId: string; stoppedAt?: number | undefined },
): void {
  if (session.stoppedAt !== undefined) acknowledged.set(session.sessionId, session.stoppedAt)
}

/**
 * What waits, as the icon's colour shows it: nothing, a yes/no request (or a Notification wait),
 * or a request that asks for a choice (`isChoiceKind`), which wins over yes/no.
 */
type TrayWait = 'none' | 'yes-no' | 'choice'

export interface TrayState {
  /** The sessions whose status is `waiting`: the number the tooltip gives. */
  waitingCount: number
  wait: TrayWait
  /** The sessions that finished (`hasFinished`) and whose finish the user has not seen yet. */
  finishedCount: number
  /**
   * A request the app can still decide has been held longer than `PERMISSION_WARN_AFTER_MS`: the
   * icon flashes until it is decided, released or gone.
   */
  flash: boolean
}

/** Nothing waits and nothing finished: the icon before the first tick. */
export const IDLE_TRAY_STATE: TrayState = { waitingCount: 0, wait: 'none', finishedCount: 0, flash: false }

/** The tray's state from the daemon's state. Pure; `main/index.ts` calls it in the one-second tray tick. */
export function trayState(input: TrayInput): TrayState {
  const waitingCount = input.sessions.filter((session) => session.status === 'waiting').length
  const held = input.decisions.filter((decision) => !decision.released)
  const wait: TrayWait = held.some((decision) => isChoiceKind(decision.kind))
    ? 'choice'
    : waitingCount > 0 || held.length > 0
      ? 'yes-no'
      : 'none'
  const finishedCount = input.sessions.filter(
    (session) => hasFinished(session) && input.acknowledged.get(session.sessionId) !== session.stoppedAt,
  ).length
  const flash = held.some((decision) => input.now - decision.createdAt > PERMISSION_WARN_AFTER_MS)
  return { waitingCount, wait, finishedCount, flash }
}

const APP_NAME = 'ClaudeSwitcher'

/** The tray icon's tooltip: the app name, then what waits, then what finished. */
export function trayTooltip(state: TrayState): string {
  const parts: string[] = []
  if (state.waitingCount > 0) parts.push(`${String(state.waitingCount)} session vár rád`)
  if (state.wait === 'choice') parts.push('választásra vár')
  if (state.finishedCount > 0) parts.push(`${String(state.finishedCount)} végzett`)
  return parts.length === 0 ? APP_NAME : `${APP_NAME}: ${parts.join(', ')}`
}
