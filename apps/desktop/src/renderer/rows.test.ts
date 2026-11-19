import { describe, expect, it } from 'vitest'
import type { DecisionKind, SessionStatus as Status } from '@claudeswitcher/core'
import { activeDecision, buildRows, panelRequest, pendingBadge, rowFolder, waitsOutsideApp } from './rows.js'
import { moveSelection, nextAfterDecision, selectOnShow } from './selection.js'

const session = (
  sessionId: string,
  status: Status,
  waitingSince?: number,
  extra: { stoppedAt?: number; lastEventAt?: number; name?: string; usageLimit?: { kind?: string } } = {},
) => ({
  sessionId,
  status,
  name: extra.name ?? `name-${sessionId}`,
  waitingSince,
  stoppedAt: extra.stoppedAt,
  activity: { lastEventAt: extra.lastEventAt, usageLimit: extra.usageLimit },
})

const decision = (
  id: string,
  sessionId: string,
  createdAt: number,
  released = false,
  cwd = 'P:\\proj\\alpha',
  kind: DecisionKind = 'tool',
) => ({
  id,
  sessionId,
  createdAt,
  released,
  kind,
  cwd,
})

/** Nothing seen, unless a test says otherwise. */
const NONE_SEEN = new Map<string, number>()

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
  it('attaches each session\'s requests to its row', () => {
    const rows = buildRows([session('a', 'waiting', 5), session('b', 'idle')], [decision('d1', 'a', 5)], NONE_SEEN)
    expect(rows.map((r) => [r.sessionId, r.decisions.map((d) => d.id)])).toEqual([
      ['a', ['d1']],
      ['b', []],
    ])
    expect(rows[0]?.session?.name).toBe('name-a')
  })

  it('shows a held request whose session is not in the snapshot as its own waiting row', () => {
    // Design doc, section 8: approval works without the session discovery too, in a new session's
    // first seconds or when the registry format has changed.
    const rows = buildRows([session('known', 'idle')], [decision('d1', 'ghost', 7, false, 'P:\\08_Apps\\Ghost\\')], NONE_SEEN)
    const orphan = rows.find((r) => r.sessionId === 'ghost')
    expect(orphan).toMatchObject({ name: 'Ghost', status: 'waiting', waitingSince: 7, session: undefined })
    expect(orphan?.decisions.map((d) => d.id)).toEqual(['d1'])
  })

  it('places an orphan row among the waiting sessions by when it started waiting', () => {
    const rows = buildRows(
      [session('w1', 'waiting', 10), session('w2', 'waiting', 30), session('i', 'idle')],
      [decision('dw1', 'w1', 10), decision('o', 'ghost', 20), decision('dw2', 'w2', 30)],
      NONE_SEEN,
    )
    expect(rows.map((r) => r.sessionId)).toEqual(['w1', 'ghost', 'w2', 'i'])
  })

  it('puts an orphan row before the non-waiting sessions', () => {
    const rows = buildRows([session('i', 'idle'), session('k', 'working')], [decision('o', 'ghost', 99)], NONE_SEEN)
    expect(rows.map((r) => r.sessionId)).toEqual(['ghost', 'k', 'i'])
  })

  it('groups several orphan requests of one session into one row, named from the cwd', () => {
    const rows = buildRows([], [decision('o1', 'ghost', 4, false, '/home/u/proj'), decision('o2', 'ghost', 6)], NONE_SEEN)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'ghost', name: 'proj', waitingSince: 4 })
    expect(rows[0]?.decisions.map((d) => d.id)).toEqual(['o1', 'o2'])
  })

  it('falls back to the session id when the request has no cwd', () => {
    expect(buildRows([], [decision('o', 'ghost', 1, false, '')], NONE_SEEN)[0]?.name).toBe('ghost')
  })

  it('gives each row the marker statusMarker gives it', () => {
    const rows = buildRows([session('f', 'idle', undefined, { stoppedAt: 5 })], [decision('o', 'ghost', 1)], new Map([['f', 5]]))
    expect(rows.map((r) => [r.sessionId, r.marker.tone])).toEqual([
      ['ghost', 'waiting'],
      ['f', 'seen'],
    ])
  })
})

describe('buildRows order', () => {
  const ids = (rows: { sessionId: string }[]): string[] => rows.map((r) => r.sessionId)

  it('orders the groups by marker: yes/no, choice, released, unseen done, working, seen done, usage limit, idle', () => {
    // The daemon's order is the reverse on purpose: the rows must not keep it.
    const sessions = [
      session('idle', 'idle'),
      session('limit', 'idle', undefined, { stoppedAt: 55, usageLimit: { kind: 'five_hour' } }),
      session('seen', 'idle', undefined, { stoppedAt: 50 }),
      session('working', 'working'),
      session('done', 'idle', undefined, { stoppedAt: 60 }),
      session('released', 'waiting', 30),
      session('choice', 'waiting', 40),
      session('yesno', 'waiting', 45),
    ]
    const decisions = [
      decision('dr', 'released', 30, true),
      decision('dc', 'choice', 40, false, 'P:\\proj\\alpha', 'question'),
      decision('dy', 'yesno', 45),
    ]
    const rows = buildRows(sessions, decisions, new Map([['seen', 50]]))
    expect(rows.map((r) => r.marker.tone)).toEqual(['waiting', 'choice', 'released', 'done', 'working', 'seen', 'limit', 'idle'])
    expect(ids(rows)).toEqual(['yesno', 'choice', 'released', 'done', 'working', 'seen', 'limit', 'idle'])
  })

  it('puts a session that waits on the sessions it prompted right after the working ones, naming them', () => {
    // Invented pipes in the measured shape (design doc "Cross-session messages").
    const pipe = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
    const other = String.raw`\\.\pipe\LOCAL\cc-msg-f9e8d7c6b5a4938271605f4e3d2c1b0a`
    const worksFor = (sessionId: string, name: string, status: Status, ...pipes: string[]) => ({
      ...session(sessionId, status, undefined, { name }),
      activity: { promptedBy: pipes.map((p) => ({ pipe: p })) },
    })
    const sessions = [
      session('seen', 'idle', undefined, { stoppedAt: 50 }),
      { ...session('hub', 'idle', undefined, { stoppedAt: 60, name: 'Orchestrator' }), messagingSocketPath: pipe },
      { ...session('peer', 'idle', undefined, { stoppedAt: 61, name: 'Reviewer' }), messagingSocketPath: other },
      worksFor('crm', 'CRM master', 'waiting', pipe),
      worksFor('app', 'BohemApp', 'working', pipe, other),
    ]
    const rows = buildRows(sessions, [], new Map([['seen', 50]]))
    expect(rows.map((r) => [r.sessionId, r.marker.tone])).toEqual([
      ['crm', 'waiting'],
      ['app', 'working'],
      // Within the group the most recently touched first, as in the other finished groups.
      ['peer', 'waits-on'],
      ['hub', 'waits-on'],
      ['seen', 'seen'],
    ])
    const byId = new Map(rows.map((r) => [r.sessionId, r]))
    expect(byId.get('hub')!.waitsOn).toEqual(['BohemApp', 'CRM master'])
    expect(byId.get('peer')!.waitsOn).toEqual(['BohemApp'])
    expect(byId.get('app')!.promptedBy).toEqual(['Orchestrator', 'Reviewer'])
    expect(byId.get('crm')!.promptedBy).toEqual(['Orchestrator'])
    expect(byId.get('seen')!.waitsOn).toEqual([])
    expect(byId.get('seen')!.promptedBy).toEqual([])
  })

  it('counts a Notification wait without a request in the yes/no group', () => {
    const rows = buildRows([session('w', 'working'), session('n', 'waiting', 9)], [], NONE_SEEN)
    expect(ids(rows)).toEqual(['n', 'w'])
  })

  it('puts the longest waiting first in the yes/no and in the choice group', () => {
    const sessions = [session('y2', 'waiting', 20), session('c2', 'waiting', 25), session('y1', 'waiting', 10), session('c1', 'waiting', 15)]
    const decisions = [
      decision('dy2', 'y2', 20),
      decision('dc2', 'c2', 25, false, 'P:\\proj\\alpha', 'plan'),
      decision('dy1', 'y1', 10),
      decision('dc1', 'c1', 15, false, 'P:\\proj\\alpha', 'question'),
    ]
    expect(ids(buildRows(sessions, decisions, NONE_SEEN))).toEqual(['y1', 'y2', 'c1', 'c2'])
  })

  it('sorts an orphan row with the waiting rows by its oldest request', () => {
    const sessions = [session('w2', 'waiting', 30), session('w1', 'waiting', 10), session('i', 'idle')]
    const decisions = [decision('dw2', 'w2', 30), decision('o2', 'ghost', 25), decision('o1', 'ghost', 20), decision('dw1', 'w1', 10)]
    const rows = buildRows(sessions, decisions, NONE_SEEN)
    expect(ids(rows)).toEqual(['w1', 'ghost', 'w2', 'i'])
    expect(rows[1]?.waitingSince).toBe(20)
  })

  it('puts the most recently touched first in the other groups: the latest of activity, stop and wait', () => {
    const sessions = [
      // Last event at 100: older than the others' latest.
      session('a', 'idle', undefined, { lastEventAt: 100 }),
      // Its wait (300) is the latest of its values.
      session('b', 'idle', 300, { lastEventAt: 200 }),
      session('c', 'idle', undefined, { lastEventAt: 250 }),
    ]
    expect(ids(buildRows(sessions, [], NONE_SEEN))).toEqual(['b', 'c', 'a'])

    // In a done group the stop counts too: d1's stop (400) is later than d2's last event (395).
    const done = [
      session('d2', 'idle', undefined, { stoppedAt: 380, lastEventAt: 395 }),
      session('d1', 'idle', undefined, { stoppedAt: 400, lastEventAt: 390 }),
    ]
    expect(ids(buildRows(done, [], NONE_SEEN))).toEqual(['d1', 'd2'])
  })

  it('sorts the working group by name, not by its activity, which moves with every event', () => {
    const sessions = [
      session('s1', 'working', undefined, { name: 'gamma', lastEventAt: 300 }),
      session('s2', 'working', undefined, { name: 'alpha', lastEventAt: 100 }),
      session('s3', 'working', undefined, { name: 'beta', lastEventAt: 200 }),
    ]
    expect(ids(buildRows(sessions, [], NONE_SEEN))).toEqual(['s2', 's3', 's1'])
    // A few seconds later: newer events in another order, the same rows.
    const later = sessions.map((s, i) => ({ ...s, activity: { lastEventAt: 400 - i * 50 } }))
    expect(ids(buildRows(later, [], NONE_SEEN))).toEqual(['s2', 's3', 's1'])
  })

  it('counts a held request from its arrival: a later Notification wait does not reorder the rows', () => {
    // The request of `early` came first, but its permission_prompt Notification moved its `waitingSince` later.
    const sessions = [session('late', 'waiting', 12), session('early', 'waiting', 16)]
    const decisions = [decision('de', 'early', 10), decision('dl', 'late', 12)]
    expect(ids(buildRows(sessions, decisions, NONE_SEEN))).toEqual(['early', 'late'])
  })

  it('does not count an old released request as the wait of a fresh held one', () => {
    // `mixed` carries the start of its released request as `waitingSince`, but what it holds is newer.
    const sessions = [session('mixed', 'waiting', 1), session('steady', 'waiting', 20)]
    const decisions = [decision('dr', 'mixed', 1, true), decision('dm', 'mixed', 50), decision('ds', 'steady', 20)]
    const rows = buildRows(sessions, decisions, NONE_SEEN)
    expect(rows.map((r) => [r.sessionId, r.marker.tone])).toEqual([
      ['steady', 'waiting'],
      ['mixed', 'waiting'],
    ])
    expect(selectOnShow(rows, decisions, undefined)).toBe('steady')
  })

  it('does not throw on a session without a name or an activity, which the daemon message may lack', () => {
    const bare = { sessionId: 'bare', status: 'working' as const }
    const rows = buildRows([bare, session('k', 'working', undefined, { name: 'kappa' })], [], NONE_SEEN)
    expect(ids(rows)).toEqual(['bare', 'k'])
    expect(rows[0]?.name).toBe('')
    const idle = buildRows([{ sessionId: 'quiet', status: 'idle' as const }, session('i', 'idle', undefined, { lastEventAt: 5 })], [], NONE_SEEN)
    expect(ids(idle)).toEqual(['i', 'quiet'])
  })

  it('sorts the released group by recent activity, not by its wait', () => {
    // r2 waits longer, r1 was active later.
    const sessions = [session('r2', 'waiting', 10, { lastEventAt: 40 }), session('r1', 'waiting', 20, { lastEventAt: 50 })]
    const decisions = [decision('d2', 'r2', 10, true), decision('d1', 'r1', 20, true)]
    expect(ids(buildRows(sessions, decisions, NONE_SEEN))).toEqual(['r1', 'r2'])
  })

  it('puts a row without any time after the touched ones of its group', () => {
    const sessions = [session('none', 'idle'), session('touched', 'idle', undefined, { lastEventAt: 5 })]
    expect(ids(buildRows(sessions, [], NONE_SEEN))).toEqual(['touched', 'none'])
  })

  it('breaks ties by name, then by session id, whatever the input order', () => {
    const sessions = [
      session('s3', 'idle', undefined, { name: 'beta' }),
      session('s2', 'idle', undefined, { name: 'alpha' }),
      session('s1', 'idle', undefined, { name: 'alpha' }),
    ]
    expect(ids(buildRows(sessions, [], NONE_SEEN))).toEqual(['s1', 's2', 's3'])
    expect(ids(buildRows([...sessions].reverse(), [], NONE_SEEN))).toEqual(['s1', 's2', 's3'])
  })
})

describe('panelRequest', () => {
  it('gives the selected row and its active request, the one the panel shows', () => {
    const [row] = buildRows([session('a', 'waiting', 4)], [decision('old', 'a', 1, true), decision('live', 'a', 2)], NONE_SEEN)
    const panel = panelRequest(row)
    expect(panel?.row.sessionId).toBe('a')
    expect(panel?.decision.id).toBe('live')
  })

  it('is undefined without a selected row or without a request: then the status bar names the source', () => {
    const [row] = buildRows([session('i', 'idle')], [], NONE_SEEN)
    expect(panelRequest(row)).toBeUndefined()
    expect(panelRequest(undefined)).toBeUndefined()
  })
})

describe('waitsOutsideApp', () => {
  it('is true for a waiting session without a held request (registry or Notification wait)', () => {
    // E.g. the app restarted while the session was already waiting: the request went to the old daemon.
    const [row] = buildRows([session('r', 'waiting', 4)], [], NONE_SEEN)
    expect(row !== undefined && waitsOutsideApp(row)).toBe(true)
  })

  it('is false when the app holds a request for the row', () => {
    const [row] = buildRows([session('a', 'waiting', 4)], [decision('d', 'a', 4)], NONE_SEEN)
    expect(row !== undefined && waitsOutsideApp(row)).toBe(false)
  })

  it('is false for a session that is not waiting', () => {
    const rows = buildRows([session('i', 'idle'), session('k', 'working')], [], NONE_SEEN)
    expect(rows.map(waitsOutsideApp)).toEqual([false, false])
  })
})

describe('selection with a registry-only wait', () => {
  it('selects the registry-only waiting session on show: it is the oldest waiting', () => {
    const rows = buildRows([session('r', 'waiting', 2), session('i', 'idle')], [], NONE_SEEN)
    expect(selectOnShow(rows, [], 'i')).toBe('r')
  })

  it('moves to it after a decision instead of hiding', () => {
    const decisions = [decision('d', 'a', 1)]
    const rows = buildRows([session('a', 'waiting', 1), session('r', 'waiting', 2), session('i', 'idle')], decisions, NONE_SEEN)
    expect(nextAfterDecision(rows, decisions, decisions[0]!, true)).toEqual({ select: 'r', hide: false })
  })
})

describe('selection over merged rows', () => {
  it('selects, moves to and steps past an orphan row like any other row', () => {
    const decisions = [decision('o', 'ghost', 3)]
    const rows = buildRows([session('i', 'idle'), session('k', 'working')], decisions, NONE_SEEN)
    expect(selectOnShow(rows, decisions, 'k')).toBe('ghost')
    expect(moveSelection(rows.map((r) => r.sessionId), 'ghost', 1)).toBe('k')
    expect(nextAfterDecision(rows, decisions, decisions[0]!, true)).toEqual({ hide: true })
  })

  it('preselects the longest waiting decidable row, even when a younger yes/no row is listed first', () => {
    const decisions = [decision('dy', 'yesno', 20), decision('dc', 'choice', 10, false, 'P:\\proj\\alpha', 'question')]
    const rows = buildRows([session('yesno', 'waiting', 20), session('choice', 'waiting', 10)], decisions, NONE_SEEN)
    expect(rows.map((r) => r.sessionId)).toEqual(['yesno', 'choice'])
    expect(selectOnShow(rows, decisions, undefined)).toBe('choice')
    expect(nextAfterDecision(rows, decisions, decisions[1]!, true)).toEqual({ select: 'yesno', hide: false })
  })

  it('falls back to the longest waiting released row, not the most recently active one', () => {
    const decisions = [decision('d1', 'r1', 10, true), decision('d2', 'r2', 20, true)]
    const sessions = [session('r1', 'waiting', 10, { lastEventAt: 30 }), session('r2', 'waiting', 20, { lastEventAt: 40 })]
    const rows = buildRows(sessions, decisions, NONE_SEEN)
    expect(rows.map((r) => r.sessionId)).toEqual(['r2', 'r1'])
    expect(selectOnShow(rows, decisions, undefined)).toBe('r1')
  })
})

describe('rowFolder', () => {
  it('is the session\'s cwd', () => {
    expect(rowFolder({ session: { cwd: 'P:\\proj\\alpha' }, decisions: [{ cwd: 'P:\\proj\\beta' }] })).toBe('P:\\proj\\alpha')
  })

  it('is the oldest request\'s cwd for a row without a session', () => {
    expect(rowFolder({ decisions: [{ cwd: 'P:\\proj\\beta' }, { cwd: 'P:\\proj\\gamma' }] })).toBe('P:\\proj\\beta')
  })

  it('is undefined when the app knows no folder', () => {
    expect(rowFolder({ session: { cwd: '' }, decisions: [] })).toBeUndefined()
    expect(rowFolder({ decisions: [{ cwd: '' }] })).toBeUndefined()
    expect(rowFolder({ decisions: [] })).toBeUndefined()
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
