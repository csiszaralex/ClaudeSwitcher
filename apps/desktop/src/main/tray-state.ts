import type { DecisionKind, SessionStatus } from '@claudeswitcher/core'
import { isChoiceKind } from '../shared/request-kind.js'

/** The part of a session the tray reads; the daemon's `SessionView` fits it. */
export interface TraySession {
  status: SessionStatus
}

/** The part of a pending request the tray reads; the daemon's `PendingDecisionView` fits it. */
export interface TrayDecision {
  kind: DecisionKind
  /** Released by the app (`PERMISSION_RELEASE_AFTER_MS`): it can no longer be decided here. */
  released: boolean
}

export interface TrayInput {
  sessions: readonly TraySession[]
  decisions: readonly TrayDecision[]
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
}

/** Nothing waits: the icon before the first tick. */
export const IDLE_TRAY_STATE: TrayState = { waitingCount: 0, wait: 'none' }

/** The tray's state from the daemon's state. Pure; `main/index.ts` calls it in the one-second tray tick. */
export function trayState(input: TrayInput): TrayState {
  const waitingCount = input.sessions.filter((session) => session.status === 'waiting').length
  const held = input.decisions.filter((decision) => !decision.released)
  const wait: TrayWait = held.some((decision) => isChoiceKind(decision.kind))
    ? 'choice'
    : waitingCount > 0 || held.length > 0
      ? 'yes-no'
      : 'none'
  return { waitingCount, wait }
}

const APP_NAME = 'ClaudeSwitcher'

/** The tray icon's tooltip: the app name, then what waits. */
export function trayTooltip(state: TrayState): string {
  const parts: string[] = []
  if (state.waitingCount > 0) parts.push(`${String(state.waitingCount)} session vár rád`)
  if (state.wait === 'choice') parts.push('választásra vár')
  return parts.length === 0 ? APP_NAME : `${APP_NAME}: ${parts.join(', ')}`
}
