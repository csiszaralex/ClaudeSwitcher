import { describe, expect, it } from 'vitest'
import type { SessionStatus as Status } from '@claudeswitcher/core'
import { activeDecision, buildRows, pendingBadge, waitsOutsideApp } from './rows.js'
import { moveSelection, nextAfterDecision, selectOnShow } from './selection.js'

const session = (sessionId: string, status: Status, waitingSince?: number) => ({
  sessionId,
  status,
  name: `name-${sessionId}`,
  waitingSince,
})

const decision = (id: string, sessionId: string, createdAt: number, released = false, cwd = 'P:\\proj\\alpha') => ({
  id,
  sessionId,
  createdAt,
  released,
  cwd,
})

describe('activeDecision', () => {
  it('prefers the oldest request the app can still decide over an older released one', () => {
    const list = [decision('old', 's', 1, true), decision('live', 's', 2), decision('later', 's', 3)]
    expect(activeDecision(list)?.id).toBe('live')
  })

  it('falls back to the oldest released one when nothing is decidable', () => {
    expect(activeDecision([decision('r1', 's', 1, true), decision('r2', 's', 2, true)])?.id).toBe('r1')
  })

  it('returns undefined for no requests', () => {
    expect(activeDecision<{ released: boolean }>([])).toBeUndefined()
  })
})

describe('buildRows', () => {
  it('keeps the daemon\'s session order and attaches each session\'s requests', () => {
    const rows = buildRows([session('a', 'waiting', 5), session('b', 'idle')], [decision('d1', 'a', 5)])
    expect(rows.map((r) => [r.sessionId, r.decisions.map((d) => d.id)])).toEqual([
      ['a', ['d1']],
      ['b', []],
    ])
    expect(rows[0]?.session?.name).toBe('name-a')
  })

  it('shows a held request whose session is not in the snapshot as its own waiting row', () => {
    // Spec §8: a jóváhagyás a felderítés nélkül is működik — egy új session első másodperceiben,
    // vagy ha a registry formátuma megváltozott.
    const rows = buildRows([session('known', 'idle')], [decision('d1', 'ghost', 7, false, 'P:\\08_Apps\\Ghost\\')])
    const orphan = rows.find((r) => r.sessionId === 'ghost')
    expect(orphan).toMatchObject({ name: 'Ghost', status: 'waiting', waitingSince: 7, session: undefined })
    expect(orphan?.decisions.map((d) => d.id)).toEqual(['d1'])
  })

  it('places an orphan row among the waiting sessions by when it started waiting', () => {
    const rows = buildRows(
      [session('w1', 'waiting', 10), session('w2', 'waiting', 30), session('i', 'idle')],
      [decision('dw1', 'w1', 10), decision('o', 'ghost', 20), decision('dw2', 'w2', 30)],
    )
    expect(rows.map((r) => r.sessionId)).toEqual(['w1', 'ghost', 'w2', 'i'])
  })

  it('puts an orphan row before the non-waiting sessions', () => {
    const rows = buildRows([session('i', 'idle'), session('k', 'working')], [decision('o', 'ghost', 99)])
    expect(rows.map((r) => r.sessionId)).toEqual(['ghost', 'i', 'k'])
  })

  it('groups several orphan requests of one session into one row, named from the cwd', () => {
    const rows = buildRows([], [decision('o1', 'ghost', 4, false, '/home/u/proj'), decision('o2', 'ghost', 6)])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'ghost', name: 'proj', waitingSince: 4 })
    expect(rows[0]?.decisions.map((d) => d.id)).toEqual(['o1', 'o2'])
  })

  it('falls back to the session id when the request has no cwd', () => {
    expect(buildRows([], [decision('o', 'ghost', 1, false, '')])[0]?.name).toBe('ghost')
  })
})

describe('waitsOutsideApp', () => {
  it('is true for a waiting session without a held request (registry or Notification wait)', () => {
    // Pl. az app újraindult, miközben a session már várt: a kérés a régi daemonhoz ment.
    const [row] = buildRows([session('r', 'waiting', 4)], [])
    expect(row !== undefined && waitsOutsideApp(row)).toBe(true)
  })

  it('is false when the app holds a request for the row', () => {
    const [row] = buildRows([session('a', 'waiting', 4)], [decision('d', 'a', 4)])
    expect(row !== undefined && waitsOutsideApp(row)).toBe(false)
  })

  it('is false for a session that is not waiting', () => {
    const rows = buildRows([session('i', 'idle'), session('k', 'working')], [])
    expect(rows.map(waitsOutsideApp)).toEqual([false, false])
  })
})

describe('selection with a registry-only wait', () => {
  it('selects the registry-only waiting session on show — it is the oldest waiting', () => {
    const rows = buildRows([session('r', 'waiting', 2), session('i', 'idle')], [])
    expect(selectOnShow(rows, [], 'i')).toBe('r')
  })

  it('moves to it after a decision instead of hiding', () => {
    const decisions = [decision('d', 'a', 1)]
    const rows = buildRows([session('a', 'waiting', 1), session('r', 'waiting', 2), session('i', 'idle')], decisions)
    expect(nextAfterDecision(rows, decisions, decisions[0]!, true)).toEqual({ select: 'r', hide: false })
  })
})

describe('selection over merged rows', () => {
  it('selects, moves to and steps past an orphan row like any other row', () => {
    const decisions = [decision('o', 'ghost', 3)]
    const rows = buildRows([session('i', 'idle'), session('k', 'working')], decisions)
    expect(selectOnShow(rows, decisions, 'k')).toBe('ghost')
    expect(moveSelection(rows.map((r) => r.sessionId), 'ghost', 1)).toBe('i')
    expect(nextAfterDecision(rows, decisions, decisions[0]!, true)).toEqual({ hide: true })
  })
})

describe('pendingBadge', () => {
  it('counts the requests the app can still decide once there is more than one', () => {
    expect(pendingBadge([decision('a', 's', 1), decision('b', 's', 2)])).toBe('2 vár')
    expect(pendingBadge([decision('a', 's', 1), decision('b', 's', 2), decision('c', 's', 3)])).toBe('3 vár')
  })

  it('has no badge for one request or none', () => {
    expect(pendingBadge([decision('a', 's', 1)])).toBeUndefined()
    expect(pendingBadge([])).toBeUndefined()
  })

  it('leaves out released requests, which only VS Code can decide', () => {
    expect(pendingBadge([decision('a', 's', 1, true), decision('b', 's', 2)])).toBeUndefined()
    expect(pendingBadge([decision('a', 's', 1, true), decision('b', 's', 2), decision('c', 's', 3)])).toBe('2 vár')
  })
})
