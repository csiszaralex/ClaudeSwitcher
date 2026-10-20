import { describe, expect, it } from 'vitest'
import { activeDecision, buildRows } from './rows.js'
import { moveSelection, nextAfterDecision, selectOnShow } from './selection.js'

type Status = 'waiting' | 'working' | 'idle' | 'unknown'

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

describe('selection over merged rows', () => {
  it('selects, moves to and steps past an orphan row like any other row', () => {
    const decisions = [decision('o', 'ghost', 3)]
    const rows = buildRows([session('i', 'idle'), session('k', 'working')], decisions)
    expect(selectOnShow(rows, decisions, 'k')).toBe('ghost')
    expect(moveSelection(rows.map((r) => r.sessionId), 'ghost', 1)).toBe('i')
    expect(nextAfterDecision(rows, decisions, decisions[0]!, true)).toEqual({ hide: true })
  })
})
