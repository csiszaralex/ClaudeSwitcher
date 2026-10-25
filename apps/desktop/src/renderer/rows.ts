import type { SessionStatus } from '@claudeswitcher/core'

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

/** A lista egy sora: egy ismert session, vagy egy függő kérés, aminek a sessionjét még nem látjuk. */
export interface Row<S extends SessionLike, D extends DecisionLike> {
  sessionId: string
  status: SessionStatus
  name: string
  waitingSince?: number | undefined
  /** A registry-ből ismert session; `undefined`, ha a sor csak a függő kérésből áll. */
  session?: S | undefined
  /** A sor függő kérései, a legrégebbi elöl. */
  decisions: D[]
}

/**
 * A panel kérése egy sor kérései közül: a legrégebbi, amit az app még eldönthet. Egy elengedett
 * kérés (590 mp) ne takarja el a mögötte várót — onnan már csak a VSCode dönthet. Ha mind
 * elengedett, a legrégebbi, hogy legalább az „Ugrás a VSCode-ba" látsszon.
 */
export function activeDecision<D extends { released: boolean }>(list: readonly D[]): D | undefined {
  return list.find((decision) => !decision.released) ?? list[0]
}

/**
 * A sor vár, de az appnak nincs róla eldönthető kérése: a várakozást csak a registry vagy egy
 * Notification ismeri (pl. az app újraindult, miközben a session már várt, vagy a
 * PermissionRequest nem ehhez a daemonhoz ment). Ilyenkor csak a VSCode dönthet.
 */
export function waitsOutsideApp(row: { status: SessionStatus; decisions: readonly unknown[] }): boolean {
  return row.status === 'waiting' && row.decisions.length === 0
}

/**
 * A sor „N vár" jelzése, ha az appból egynél több kérése dönthető. Az elengedett kérés nem
 * számít: azt már csak a VSCode döntheti el, és az állapotjel úgyis mutatja.
 */
export function pendingBadge(decisions: readonly { released: boolean }[]): string | undefined {
  const count = decisions.filter((decision) => !decision.released).length
  return count > 1 ? `${String(count)} vár` : undefined
}

function lastSegment(cwd: string): string | undefined {
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1]
}

/**
 * A sessionök és a függő kérések egy listában.
 *
 * Egy kérés, aminek a sessionje nincs a pillanatképben, saját sort kap (spec §8: a jóváhagyás a
 * felderítés nélkül is működik). Ez egy új session első másodperceiben természetes — a hook
 * azonnal jön, a registry-t csak pár másodpercenként olvassuk —, de egy megváltozott registry-
 * formátumnál is. A neve a kérés `cwd`-jének utolsó tagja, és várakozónak számít.
 *
 * A daemon a várakozókat a várakozás kezdete szerint előre rendezi; az ilyen sor ugyanebbe a
 * sorrendbe kerül, a legrégebbi kérése szerint — a nem-várók elé.
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
      name: lastSegment(first.cwd) ?? sessionId,
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
