import type { DecisionKind, PromptSender, SessionStatus } from '@claudeswitcher/core'
import { lastPathSegment } from '@claudeswitcher/core/browser'
import { promptersOf } from '../shared/prompt-links.js'
import { sessionName } from '../shared/session-name.js'
import { waitsOn, type SeenFinishes } from '../shared/session-finished.js'
import { statusMarker, type MarkerTone, type StatusMarker } from './session-marker.js'

interface DecisionLike {
  id: string
  sessionId: string
  createdAt: number
  released: boolean
  kind: DecisionKind
  cwd: string
}

interface SessionLike {
  sessionId: string
  status: SessionStatus
  // `name` and `activity` are required in `SessionView`, but at runtime the daemon's message can
  // lack them (`state-message.ts` `sanitizeState` checks neither), so the types say so, as in
  // `format.ts` `summarize`: a missing one must not throw in `buildRows` and take down the overlay.
  // The row's name is read through `sessionName`, which checks the types too.
  name?: string | undefined
  waitingSince?: number | undefined
  stoppedAt?: number | undefined
  bridgeSessionId?: unknown
  messagingSocketPath?: string | undefined
  activity?:
    | {
        lastEventAt?: number | undefined
        usageLimit?: unknown
        promptedBy?: readonly PromptSender[] | undefined
        tabTitle?: unknown
      }
    | undefined
}

/** A row of the list: a known session, or a pending request whose session is not seen yet. */
export interface Row<S extends SessionLike, D extends DecisionLike> {
  sessionId: string
  status: SessionStatus
  /**
   * The row's name: the session's shown name (`shared/session-name.ts` `sessionName`, its tab title
   * first), or for a row without a session the last segment of its request's `cwd`.
   */
  name: string
  waitingSince?: number | undefined
  /** The session known from the registry; `undefined` if the row is only the pending request. */
  session?: S | undefined
  /** The row's pending requests, the oldest first. */
  decisions: D[]
  /** The row's status marker (`statusMarker`); its tone decides the row's group in the list. */
  marker: StatusMarker
  /**
   * The shown names (`sessionName`) of the sessions this one waits on (`session-finished.ts` `waitsOn`), in a stable
   * order; empty when it waits on none. The row's text then names them (`format.ts` `waitsOnText`).
   */
  waitsOn: string[]
  /** The names of the sessions this one works for (`prompt-links.ts` `promptersOf`), for the row's note. */
  promptedBy: string[]
}

/**
 * The panel's request among a row's requests: the oldest one the app can still decide. A released
 * request (`PERMISSION_RELEASE_AFTER_MS`) must not hide the one waiting behind it: from there only
 * VS Code can decide. If all are released, the oldest, so that at least the jump to VS Code shows.
 */
export function activeDecision<D extends { released: boolean }>(list: readonly D[]): D | undefined {
  return list.find((decision) => !decision.released) ?? list[0]
}

/**
 * What the decision panel shows: the selected row and its `activeDecision`. `undefined` without a
 * selected row or without a request in it: then no panel shows, and the status bar names the row's
 * source and folder instead. With a panel the status bar leaves them out: the panel's source line
 * names the source and the request's working folder (`requestFacts`).
 */
export function panelRequest<S extends SessionLike, D extends DecisionLike>(
  row: Row<S, D> | undefined,
): { row: Row<S, D>; decision: D } | undefined {
  const decision = row === undefined ? undefined : activeDecision(row.decisions)
  return row === undefined || decision === undefined ? undefined : { row, decision }
}

/**
 * The row waits, but the app has no request about it that it can decide: only the registry or a
 * Notification knows about the wait (e.g. the app restarted while the session was already waiting,
 * or the PermissionRequest went to another daemon). Then only VS Code can decide.
 */
export function waitsOutsideApp(row: { status: SessionStatus; decisions: readonly unknown[] }): boolean {
  return row.status === 'waiting' && row.decisions.length === 0
}

/**
 * The row's folder, for the status bar: its session's `cwd`, or for a row without a session (only
 * its pending requests) the oldest request's `cwd`. `undefined` when the app knows none.
 */
export function rowFolder(row: { session?: { cwd: string } | undefined; decisions: readonly { cwd: string }[] }): string | undefined {
  const folder = row.session?.cwd ?? row.decisions[0]?.cwd
  return folder === undefined || folder === '' ? undefined : folder
}

/**
 * The row's "N waiting" badge when more than one of its requests can be decided in the app. A released
 * request does not count: only VS Code can decide it now, and the status marker shows it anyway.
 */
export function pendingBadge(decisions: readonly { released: boolean }[]): string | undefined {
  const count = decisions.filter((decision) => !decision.released).length
  return count > 1 ? `${String(count)} vár` : undefined
}

/**
 * The list's groups, in order: each marker tone's rank. The tone is the one the row shows
 * (`statusMarker`), so the order follows the marker rules without a copy of them.
 */
const TONE_RANK: Readonly<Record<MarkerTone, number>> = {
  waiting: 0,
  choice: 1,
  released: 2,
  done: 3,
  working: 4,
  // Not done yet: the sessions it prompted still work. Next to the working ones, after them.
  'waits-on': 5,
  seen: 6,
  // A session the usage limit stopped: nothing to do in it until the reset, so below every finish,
  // but above the plainly idle ones, because its text tells when it can go on.
  limit: 7,
  idle: 8,
}

/** The groups that wait for an answer in the app: in them the longest waiting row comes first. */
const WAITING_TONES: ReadonlySet<MarkerTone> = new Set<MarkerTone>(['waiting', 'choice'])

/**
 * When the row's wait began. With a held request the app can still decide: the oldest one's
 * `createdAt`, the clock the release (`PERMISSION_RELEASE_AFTER_MS`) and the tray's flash run on.
 * Not the daemon's `waitingSince` there: it prefers the Notification's wait, which a
 * `permission_prompt` Notification starts seconds after the request, and otherwise counts released
 * requests too. Without such a request (a Notification or registry wait, or only released ones):
 * `waitingSince`. `undefined` when neither is known.
 */
function waitStart(row: {
  waitingSince?: number | undefined
  decisions: readonly { createdAt: number; released: boolean }[]
}): number | undefined {
  let oldest: number | undefined
  for (const decision of row.decisions) {
    if (!decision.released && (oldest === undefined || decision.createdAt < oldest)) oldest = decision.createdAt
  }
  return oldest ?? row.waitingSince
}

/**
 * The order of two rows by the start of their wait (`waitStart`): the longer waiting first. A row
 * without a known start counts as the newest. `selection.ts` picks the row to preselect by it too.
 */
export function compareWaitStart(
  a: { waitingSince?: number | undefined; decisions: readonly { createdAt: number; released: boolean }[] },
  b: { waitingSince?: number | undefined; decisions: readonly { createdAt: number; released: boolean }[] },
): number {
  return (waitStart(a) ?? Number.MAX_SAFE_INTEGER) - (waitStart(b) ?? Number.MAX_SAFE_INTEGER)
}

/**
 * When the row was last touched: the latest of its last transcript event (`activity.lastEventAt`),
 * its `stoppedAt` and its `waitingSince`. A missing one does not count; 0 when none is known.
 */
function lastTouched(row: Row<SessionLike, DecisionLike>): number {
  const times = [row.session?.activity?.lastEventAt, row.session?.stoppedAt, row.waitingSince].filter(
    (time): time is number => time !== undefined,
  )
  return times.length === 0 ? 0 : Math.max(...times)
}

/**
 * The order of two rows of one group: in a waiting group the longest waiting first
 * (`compareWaitStart`: nearest to the release, and the overlay preselects it); in the working group
 * none (so by name), because a working session's `activity.lastEventAt` moves with every new
 * transcript event and the rows would swap places every few seconds; in any other group the most
 * recently touched first (`lastTouched`).
 */
function compareWithinGroup(a: Row<SessionLike, DecisionLike>, b: Row<SessionLike, DecisionLike>): number {
  if (WAITING_TONES.has(a.marker.tone)) return compareWaitStart(a, b)
  if (a.marker.tone === 'working') return 0
  return lastTouched(b) - lastTouched(a)
}

/**
 * The list order: by group (`TONE_RANK`), then within the group (`compareWithinGroup`). Ties go by
 * name, then by session id, so the order is stable.
 */
function compareRows(a: Row<SessionLike, DecisionLike>, b: Row<SessionLike, DecisionLike>): number {
  const rank = TONE_RANK[a.marker.tone] - TONE_RANK[b.marker.tone]
  if (rank !== 0) return rank
  const within = compareWithinGroup(a, b)
  if (within !== 0) return within
  return a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId)
}

/**
 * The sessions and the pending requests in one list, in the list's order (`compareRows`); the
 * daemon's own order of the sessions does not matter.
 *
 * A request whose session is not in the snapshot gets a row of its own (design doc, section 8:
 * approval works without the session discovery too). This is natural in a new session's first
 * seconds (the hook comes at once, the registry is read only every few seconds), but also with a
 * changed registry format. Its name is the last segment of the request's `cwd`; it counts as
 * waiting since its oldest request and sorts with the other rows by its marker.
 *
 * `seen` are the finishes the user has seen (`useSeenFinishes`), for the ✓ marker's color.
 */
export function buildRows<S extends SessionLike, D extends DecisionLike>(
  sessions: readonly S[],
  decisions: readonly D[],
  seen: SeenFinishes,
): Row<S, D>[] {
  const bySession = new Map<string, D[]>()
  for (const decision of decisions) {
    const list = bySession.get(decision.sessionId)
    if (list === undefined) bySession.set(decision.sessionId, [decision])
    else list.push(decision)
  }

  const rows: Row<S, D>[] = sessions.map((session) => {
    const own = bySession.get(session.sessionId) ?? []
    return {
      sessionId: session.sessionId,
      status: session.status,
      name: sessionName(session),
      waitingSince: session.waitingSince,
      session,
      decisions: own,
      marker: statusMarker(session, own, seen, sessions),
      waitsOn: waitsOn(session, sessions).map(sessionName),
      promptedBy: promptersOf(session, sessions),
    }
  })

  const known = new Set(sessions.map((session) => session.sessionId))
  for (const [sessionId, list] of bySession) {
    if (known.has(sessionId)) continue
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt)
    const first = sorted[0]
    if (first === undefined) continue
    rows.push({
      sessionId,
      status: 'waiting',
      name: lastPathSegment(first.cwd) ?? sessionId,
      waitingSince: first.createdAt,
      session: undefined,
      decisions: sorted,
      marker: statusMarker({ sessionId, status: 'waiting' }, sorted, seen, sessions),
      waitsOn: [],
      promptedBy: [],
    })
  }
  return rows.sort(compareRows)
}
