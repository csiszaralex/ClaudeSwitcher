import type { SessionStatus } from '@claudeswitcher/core'
import { lastPathSegment } from '@claudeswitcher/core/browser'

interface DecisionLike {
  id: string
  sessionId: string
  createdAt: number
  released: boolean
  cwd: string
}

interface SessionLike {
  sessionId: string
  status: SessionStatus
  name: string
  waitingSince?: number | undefined
}

/** A row of the list: a known session, or a pending request whose session is not seen yet. */
export interface Row<S extends SessionLike, D extends DecisionLike> {
  sessionId: string
  status: SessionStatus
  name: string
  waitingSince?: number | undefined
  /** The session known from the registry; `undefined` if the row is only the pending request. */
  session?: S | undefined
  /** The row's pending requests, the oldest first. */
  decisions: D[]
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
 * The row waits, but the app has no request about it that it can decide: only the registry or a
 * Notification knows about the wait (e.g. the app restarted while the session was already waiting,
 * or the PermissionRequest went to another daemon). Then only VS Code can decide.
 */
export function waitsOutsideApp(row: { status: SessionStatus; decisions: readonly unknown[] }): boolean {
  return row.status === 'waiting' && row.decisions.length === 0
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
 * The sessions and the pending requests in one list.
 *
 * A request whose session is not in the snapshot gets a row of its own (design doc, section 8:
 * approval works without the session discovery too). This is natural in a new session's first
 * seconds (the hook comes at once, the registry is read only every few seconds), but also with a
 * changed registry format. Its name is the last segment of the request's `cwd`, and it counts as
 * waiting.
 *
 * The daemon sorts the waiting sessions first by the start of their wait; such a row goes into the
 * same order by its oldest request, before the non-waiting ones.
 */
export function buildRows<S extends SessionLike, D extends DecisionLike>(
  sessions: readonly S[],
  decisions: readonly D[],
): Row<S, D>[] {
  const bySession = new Map<string, D[]>()
  for (const decision of decisions) {
    const list = bySession.get(decision.sessionId)
    if (list === undefined) bySession.set(decision.sessionId, [decision])
    else list.push(decision)
  }

  const rows: Row<S, D>[] = sessions.map((session) => ({
    sessionId: session.sessionId,
    status: session.status,
    name: session.name,
    waitingSince: session.waitingSince,
    session,
    decisions: bySession.get(session.sessionId) ?? [],
  }))

  const known = new Set(sessions.map((session) => session.sessionId))
  const orphans: Row<S, D>[] = []
  for (const [sessionId, list] of bySession) {
    if (known.has(sessionId)) continue
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt)
    const first = sorted[0]
    if (first === undefined) continue
    orphans.push({
      sessionId,
      status: 'waiting',
      name: lastPathSegment(first.cwd) ?? sessionId,
      waitingSince: first.createdAt,
      session: undefined,
      decisions: sorted,
    })
  }
  orphans.sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))

  for (const orphan of orphans) {
    const since = orphan.waitingSince ?? 0
    const at = rows.findIndex((row) => row.status !== 'waiting' || (row.waitingSince ?? 0) > since)
    if (at === -1) rows.push(orphan)
    else rows.splice(at, 0, orphan)
  }
  return rows
}
