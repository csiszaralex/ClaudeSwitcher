import { PERMISSION_RELEASE_AFTER_MS, type DecisionKind, type SessionStatus } from '@claudeswitcher/core'
import type { LinkedSession } from '../shared/prompt-links.js'
import { finishState, waitsOn, type SeenFinishes } from '../shared/session-finished.js'
import { sessionState, type SessionState } from '../shared/session-state.js'

/**
 * When the tray starts to flash for a held request nobody has decided: 50 s before the release
 * (`PERMISSION_RELEASE_AFTER_MS`), so the user still has time to decide it in the app.
 */
export const PERMISSION_WARN_AFTER_MS = PERMISSION_RELEASE_AFTER_MS - 50_000

/**
 * The part of a session the tray reads; the daemon's `SessionView` fits it. The links between the
 * sessions (`LinkedSession`) tell whether a finished session still waits on the ones it prompted.
 */
export interface TraySession extends LinkedSession {
  sessionId: string
  status: SessionStatus
  /** The time of the session's last `Stop`, while it has shown no new activity (`SessionView.stoppedAt`). */
  stoppedAt?: number | undefined
}

/** The part of a pending request the tray reads; the daemon's `PendingDecisionView` fits it. */
export interface TrayDecision {
  /** The session that asks, to tell the session's state (`sessionState`) as the list does. */
  sessionId: string
  kind: DecisionKind
  /** Released by the app (`PERMISSION_RELEASE_AFTER_MS`): it can no longer be decided here. */
  released: boolean
  /** When the daemon began to hold it (ms, the daemon's clock, `Date.now()`). */
  createdAt: number
}

export interface TrayInput {
  sessions: readonly TraySession[]
  decisions: readonly TrayDecision[]
  /** The finishes the user has seen (`shared/session-finished.ts` `acknowledgeFinish`). */
  acknowledged: SeenFinishes
  /** The current time (ms, `Date.now()`), for the age of the held requests. */
  now: number
}

/**
 * What waits, as the icon's colour shows it: nothing, a yes/no request (or a Notification wait),
 * a request that asks for a choice, or only requests the app has released. Each session counts with
 * its state as the list's marker shows it (`sessionState`); across the sessions a choice wins over a
 * yes/no, and either wins over a released one, because those the app can still decide.
 */
type TrayWait = 'none' | 'yes-no' | 'choice' | 'released'

/** The strength of each wait: the strongest one across the sessions is the icon's. */
const WAIT_RANK: Readonly<Record<TrayWait, number>> = { none: 0, released: 1, 'yes-no': 2, choice: 3 }

export interface TrayState {
  /**
   * The sessions whose status is `waiting`: the number the tooltip gives. A session with only
   * released requests counts too: the daemon keeps it waiting (`session-store.ts` `applyPending`),
   * since its own prompt still waits for the user.
   */
  waitingCount: number
  wait: TrayWait
  /**
   * The sessions whose finish the user has not seen yet (`finishState` `unseen`): the list's green ✓
   * rows, and its usage limit rows not opened since (the exception in `finishState`).
   */
  finishedCount: number
  /**
   * The sessions that work (`sessionState` `working`), and those that wait on the sessions they
   * prompted (`waits-on`): the list's ◐ and ◌ rows.
   */
  workingCount: number
  /**
   * A request the app can still decide has been held longer than `PERMISSION_WARN_AFTER_MS`: the
   * icon flashes until it is decided, released or gone.
   */
  flash: boolean
}

/** Nothing waits, works or finished: the icon before the first tick. */
export const IDLE_TRAY_STATE: TrayState = {
  waitingCount: 0,
  wait: 'none',
  finishedCount: 0,
  workingCount: 0,
  flash: false,
}

/** The wait a session's state stands for; `working` and `rest` wait for nothing. */
function waitOf(state: SessionState): TrayWait {
  switch (state) {
    case 'choice':
    case 'yes-no':
    case 'released':
      return state
    case 'working':
    case 'waits-on':
    case 'rest':
      return 'none'
  }
}

/**
 * The state of every row the list shows (`renderer/rows.ts` `buildRows`): each known session with
 * its own requests, and each group of requests whose session is not known yet, which the list shows
 * as a waiting row of its own.
 */
function rowStates(input: TrayInput): SessionState[] {
  const bySession = new Map<string, TrayDecision[]>()
  for (const decision of input.decisions) {
    const list = bySession.get(decision.sessionId)
    if (list === undefined) bySession.set(decision.sessionId, [decision])
    else list.push(decision)
  }
  const known = new Set(input.sessions.map((session) => session.sessionId))
  const states = input.sessions.map((session) =>
    sessionState(session.status, bySession.get(session.sessionId) ?? [], waitsOn(session, input.sessions).length > 0),
  )
  for (const [sessionId, list] of bySession) {
    if (!known.has(sessionId)) states.push(sessionState('waiting', list, false))
  }
  return states
}

/** The tray's state from the daemon's state. Pure; `main/index.ts` calls it in the one-second tray tick. */
export function trayState(input: TrayInput): TrayState {
  const waitingCount = input.sessions.filter((session) => session.status === 'waiting').length
  const states = rowStates(input)
  const wait = states.map(waitOf).reduce<TrayWait>((a, b) => (WAIT_RANK[b] > WAIT_RANK[a] ? b : a), 'none')
  // A session that waits on the sessions it prompted is not done: the icon shows it as working.
  const workingCount = states.filter((state) => state === 'working' || state === 'waits-on').length
  const finishedCount = input.sessions.filter(
    (session) => finishState(session, input.acknowledged, input.sessions) === 'unseen',
  ).length
  const flash = input.decisions.some(
    (decision) => !decision.released && input.now - decision.createdAt > PERMISSION_WARN_AFTER_MS,
  )
  return { waitingCount, wait, finishedCount, workingCount, flash }
}

const APP_NAME = 'ClaudeSwitcher'

/**
 * The tray icon's tooltip: the app name, then what waits (with the word for a burgundy or a lemon
 * icon), then what finished, then what works.
 */
export function trayTooltip(state: TrayState): string {
  const parts: string[] = []
  if (state.waitingCount > 0) parts.push(`${String(state.waitingCount)} session vár rád`)
  if (state.wait === 'choice') parts.push('választásra vár')
  if (state.wait === 'released') parts.push('az app elengedte')
  if (state.finishedCount > 0) parts.push(`${String(state.finishedCount)} végzett`)
  if (state.workingCount > 0) parts.push(`${String(state.workingCount)} dolgozik`)
  return parts.length === 0 ? APP_NAME : `${APP_NAME}: ${parts.join(', ')}`
}
