import type { SessionStatus } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
import type { DueEntry, ExcludedEntry, WeeklyReset } from '../shared/excluded-sessions.js'
import { EXCLUDED_GONE_AFTER_MS, createExcludedSessions } from './excluded-sessions.js'

// Invented session ids in the registry's UUID shape.
const ALPHA = '6f1c2a3e-0000-4000-8000-000000000061'
const BETA = '6f1c2a3e-0000-4000-8000-000000000062'
const GAMMA = '6f1c2a3e-0000-4000-8000-000000000063'
/** Idle live sessions with these ids. */
const live = (...ids: string[]): { sessionId: string; status: SessionStatus }[] => ids.map((sessionId) => ({ sessionId, status: 'idle' }))
/** One live session with this status. */
const as = (sessionId: string, status: SessionStatus) => ({ sessionId, status })
/** Excluded while idle: it comes back when it runs. */
const idle = (sessionId: string): ExcludedEntry => ({ sessionId, whileRunning: false })
/** Excluded while running: it stays out. */
const running = (sessionId: string): ExcludedEntry => ({ sessionId, whileRunning: true })

/** The excluded list with a recorder of what it persisted (the list and the due marks) and logged. */
function setup(initial: ExcludedEntry[] = [], initialDue: DueEntry[] = [], weeklyReset?: WeeklyReset) {
  const saved: ExcludedEntry[][] = []
  const savedDue: DueEntry[][] = []
  const logged: string[] = []
  const excluded = createExcludedSessions({
    initial,
    initialDue,
    weeklyReset,
    persist: (stored) => {
      saved.push(stored.excluded.map((entry) => ({ ...entry })))
      savedDue.push(stored.due.map((entry) => ({ ...entry })))
    },
    log: (line) => logged.push(line),
  })
  return { excluded, saved, savedDue, logged }
}

describe('createExcludedSessions: exclude and include', () => {
  it('starts with the stored entries and no returned session', () => {
    const { excluded, saved } = setup([idle(ALPHA), running(BETA)])
    expect(excluded.reply()).toEqual({ excluded: [idle(ALPHA), running(BETA)], returned: [], due: [] })
    expect(excluded.quietFinishes([]).has(BETA)).toBe(true)
    expect(saved).toEqual([])
  })

  it('excludes a live session and stores the list', () => {
    const { excluded, saved } = setup()
    expect(excluded.exclude(ALPHA, live(ALPHA, BETA))).toBe(true)
    expect(excluded.reply().excluded).toEqual([idle(ALPHA)])
    expect(saved).toEqual([[idle(ALPHA)]])
  })

  it('remembers a session excluded while working or waiting as excluded while running', () => {
    const { excluded, saved } = setup()
    excluded.exclude(ALPHA, [as(ALPHA, 'working')])
    excluded.exclude(BETA, [as(BETA, 'waiting')])
    excluded.exclude(GAMMA, [as(GAMMA, 'idle')])
    expect(excluded.reply().excluded).toEqual([running(ALPHA), running(BETA), idle(GAMMA)])
    expect(saved.at(-1)).toEqual([running(ALPHA), running(BETA), idle(GAMMA)])
  })

  it('does not exclude a session the daemon does not list now: a row without a session, or one that ended meanwhile', () => {
    const { excluded, saved } = setup()
    expect(excluded.exclude(GAMMA, live(ALPHA))).toBe(false)
    expect(excluded.exclude(GAMMA, [])).toBe(false)
    expect(excluded.reply().excluded).toEqual([])
    expect(saved).toEqual([])
  })

  it('is idempotent: Delete pressed twice before the reply excludes once', () => {
    const { excluded, saved } = setup()
    expect(excluded.exclude(ALPHA, live(ALPHA))).toBe(true)
    expect(excluded.exclude(ALPHA, [as(ALPHA, 'working')])).toBe(false)
    expect(excluded.reply().excluded).toEqual([idle(ALPHA)])
    expect(saved).toEqual([[idle(ALPHA)]])
  })

  it('brings a session back, once, also when it is not live any more', () => {
    const { excluded, saved } = setup([idle(ALPHA), running(BETA)])
    expect(excluded.include(ALPHA)).toBe(true)
    expect(excluded.include(ALPHA)).toBe(false)
    expect(excluded.include(GAMMA)).toBe(false)
    expect(excluded.reply().excluded).toEqual([running(BETA)])
    expect(saved).toEqual([[running(BETA)]])
  })
})

describe('createExcludedSessions: back in the list when it starts running', () => {
  it('brings back a session excluded while idle once it starts working, with the mark, and logs it', () => {
    const { excluded, saved, logged } = setup([idle(ALPHA), idle(BETA)])
    expect(excluded.observe(live(ALPHA, BETA), 0)).toBe(false)
    expect(excluded.observe([as(ALPHA, 'working'), as(BETA, 'idle')], 1000)).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [idle(BETA)], returned: [ALPHA], due: [] })
    expect(excluded.quietFinishes([as(ALPHA, 'working')]).has(ALPHA)).toBe(false)
    expect(saved).toEqual([[idle(BETA)]])
    expect(logged).toEqual([`[claudeswitcher] excluded session ${ALPHA} started running: back in the list`])
    // Nothing changes on the next tick.
    expect(excluded.observe([as(ALPHA, 'working'), as(BETA, 'idle')], 2000)).toBe(false)
  })

  it('brings back a session excluded while idle once it starts waiting', () => {
    const { excluded } = setup([idle(ALPHA)])
    expect(excluded.observe([as(ALPHA, 'waiting')], 0)).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [], returned: [ALPHA], due: [] })
  })

  it('never brings back a session excluded while working or waiting, also after an idle phase and a new run', () => {
    const { excluded, saved, logged } = setup()
    excluded.exclude(ALPHA, [as(ALPHA, 'working'), as(BETA, 'waiting')])
    excluded.exclude(BETA, [as(ALPHA, 'working'), as(BETA, 'waiting')])
    for (const [status, at] of [['working', 0], ['idle', 1000], ['waiting', 2000], ['idle', 3000], ['working', 4000]] as const) {
      expect(excluded.observe([as(ALPHA, status), as(BETA, status)], at)).toBe(false)
    }
    expect(excluded.reply()).toEqual({ excluded: [running(ALPHA), running(BETA)], returned: [], due: [] })
    expect(saved).toHaveLength(2)
    expect(logged).toEqual([])
  })

  it('ends the mark on the jump, once', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe([as(ALPHA, 'working')], 0)
    expect(excluded.acknowledgeReturn(ALPHA)).toBe(true)
    expect(excluded.acknowledgeReturn(ALPHA)).toBe(false)
    expect(excluded.acknowledgeReturn(BETA)).toBe(false)
    expect(excluded.reply()).toEqual({ excluded: [], returned: [], due: [] })
  })

  it('ends the mark when the session is excluded again, now as excluded while running', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe([as(ALPHA, 'working')], 0)
    expect(excluded.exclude(ALPHA, [as(ALPHA, 'working')])).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [running(ALPHA)], returned: [], due: [] })
    expect(excluded.observe([as(ALPHA, 'working')], 1000)).toBe(false)
  })

  it('ends the mark of a session gone for EXCLUDED_GONE_AFTER_MS without a break, never from an empty list', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe([as(ALPHA, 'working'), as(BETA, 'idle')], 0)
    expect(excluded.observe([], 1)).toBe(false)
    expect(excluded.observe(live(BETA), 1000)).toBe(false)
    expect(excluded.observe(live(BETA), 1000 + EXCLUDED_GONE_AFTER_MS - 1)).toBe(false)
    expect(excluded.reply().returned).toEqual([ALPHA])
    expect(excluded.observe(live(BETA), 1000 + EXCLUDED_GONE_AFTER_MS)).toBe(true)
    expect(excluded.reply().returned).toEqual([])
  })

  it('keeps the mark of a session that comes back before that', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe([as(ALPHA, 'working'), as(BETA, 'idle')], 0)
    excluded.observe(live(BETA), 1000)
    excluded.observe([as(ALPHA, 'idle'), as(BETA, 'idle')], 1000 + EXCLUDED_GONE_AFTER_MS - 1)
    expect(excluded.observe(live(BETA), 1000 + EXCLUDED_GONE_AFTER_MS)).toBe(false)
    expect(excluded.reply().returned).toEqual([ALPHA])
  })
})

describe('createExcludedSessions: dropping the ids of gone sessions', () => {
  it('drops an id missing for EXCLUDED_GONE_AFTER_MS without a break, and stores the list', () => {
    const { excluded, saved } = setup([idle(ALPHA), running(BETA)])
    expect(excluded.observe(live(BETA), 0)).toBe(false)
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS - 1)).toBe(false)
    expect(excluded.reply().excluded).toEqual([idle(ALPHA), running(BETA)])
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)).toBe(true)
    expect(excluded.reply().excluded).toEqual([running(BETA)])
    expect(saved).toEqual([[running(BETA)]])
  })

  it('keeps an id whose session comes back before that, and counts again from its next absence', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe(live(BETA), 0)
    excluded.observe(live(ALPHA, BETA), EXCLUDED_GONE_AFTER_MS - 1)
    excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)
    expect(excluded.observe(live(BETA), 2 * EXCLUDED_GONE_AFTER_MS - 1)).toBe(false)
    expect(excluded.reply().excluded).toEqual([idle(ALPHA)])
  })

  it('never drops from an empty list, and an empty list restarts every count', () => {
    // The daemon's list is empty before its first scan, and while the process probe has no snapshot.
    const { excluded, saved } = setup([idle(ALPHA)])
    expect(excluded.observe([], 0)).toBe(false)
    expect(excluded.observe([], 10 * EXCLUDED_GONE_AFTER_MS)).toBe(false)
    excluded.observe(live(BETA), 0)
    excluded.observe([], EXCLUDED_GONE_AFTER_MS / 2)
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)).toBe(false)
    expect(excluded.reply().excluded).toEqual([idle(ALPHA)])
    expect(saved).toEqual([])
  })

  it('does not count an id brought back and excluded again from its old absence', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe(live(BETA), 0)
    excluded.include(ALPHA)
    excluded.exclude(ALPHA, live(ALPHA))
    // Missing again only from here on.
    excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS + 1)).toBe(false)
    expect(excluded.reply().excluded).toEqual([idle(ALPHA)])
  })
})

describe('createExcludedSessions: excluded until a time', () => {
  /** Excluded while idle until `until`. */
  const idleUntil = (sessionId: string, until: number): ExcludedEntry => ({ sessionId, whileRunning: false, until })
  const T = 1_000_000

  it('excludes a live session until the time, remembering how, and stores it', () => {
    const { excluded, saved } = setup()
    expect(excluded.excludeUntil(ALPHA, T, live(ALPHA), T - 1)).toBe(true)
    expect(excluded.excludeUntil(BETA, T, [as(BETA, 'working')], T - 1)).toBe(true)
    expect(excluded.reply().excluded).toEqual([idleUntil(ALPHA, T), { sessionId: BETA, whileRunning: true, until: T }])
    expect(saved.at(-1)).toEqual(excluded.reply().excluded)
  })

  it('refuses a time that is not a finite number or not in the future, and a session the daemon does not list', () => {
    const { excluded, saved } = setup()
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, T - 1, T, String(T + 1), undefined, null, { until: T + 1 }]) {
      expect(excluded.excludeUntil(ALPHA, bad, live(ALPHA), T)).toBe(false)
    }
    expect(excluded.excludeUntil(GAMMA, T + 1, live(ALPHA), T)).toBe(false)
    expect(excluded.reply().excluded).toEqual([])
    expect(saved).toEqual([])
  })

  it('gives an excluded session a new time and keeps its whileRunning, with or without a time before', () => {
    const { excluded, saved } = setup([running(ALPHA), idleUntil(BETA, T)])
    // Neither has to be live: only the time changes.
    expect(excluded.excludeUntil(ALPHA, T + 5, [], T)).toBe(true)
    expect(excluded.excludeUntil(BETA, T + 7, [as(BETA, 'working')], T)).toBe(true)
    expect(excluded.reply().excluded).toEqual([{ sessionId: ALPHA, whileRunning: true, until: T + 5 }, idleUntil(BETA, T + 7)])
    // The same time again changes nothing.
    expect(excluded.excludeUntil(BETA, T + 7, [], T)).toBe(false)
    expect(saved).toHaveLength(2)
  })

  it('drops the time on Delete (include)', () => {
    const { excluded } = setup([idleUntil(ALPHA, T)])
    expect(excluded.include(ALPHA)).toBe(true)
    expect(excluded.reply().excluded).toEqual([])
    expect(excluded.observe(live(ALPHA), T)).toBe(false)
    expect(excluded.reply().due).toEqual([])
  })

  it('turns into a due mark at the time, stores both keys in one write, logs it, and the next tick changes nothing', () => {
    const { excluded, saved, savedDue, logged } = setup([idleUntil(ALPHA, T), idle(BETA)])
    expect(excluded.observe(live(ALPHA, BETA), T - 1)).toBe(false)
    expect(excluded.observe(live(ALPHA, BETA), T)).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [idle(BETA)], returned: [], due: [{ sessionId: ALPHA, until: T }] })
    expect(saved).toEqual([[idle(BETA)]])
    expect(savedDue).toEqual([[{ sessionId: ALPHA, until: T }]])
    expect(logged).toEqual([`[claudeswitcher] the exclusion time of session ${ALPHA} passed: back in the list, marked`])
    expect(excluded.observe(live(ALPHA, BETA), T + 1000)).toBe(false)
  })

  it('turns into a due mark from an empty list, and from a list without the session (one tick is no picture)', () => {
    const empty = setup([idleUntil(ALPHA, T)])
    expect(empty.excluded.observe([], T)).toBe(true)
    expect(empty.excluded.reply().due).toEqual([{ sessionId: ALPHA, until: T }])
    expect(empty.savedDue).toEqual([[{ sessionId: ALPHA, until: T }]])

    const partial = setup([idleUntil(ALPHA, T)])
    expect(partial.excluded.observe(live(BETA), T)).toBe(true)
    expect(partial.excluded.reply().due).toEqual([{ sessionId: ALPHA, until: T }])
  })

  it('a time that passed while the app was off gives the mark at the first tick, and a stored mark survives a restart', () => {
    const { excluded, savedDue } = setup([idleUntil(ALPHA, T)])
    // The first tick after the start, before the daemon's first scan.
    expect(excluded.observe([], T + 3 * 86_400_000)).toBe(true)
    expect(excluded.reply().due).toEqual([{ sessionId: ALPHA, until: T }])

    const restarted = setup([], savedDue.at(-1) ?? [])
    expect(restarted.excluded.reply()).toEqual({ excluded: [], returned: [], due: [{ sessionId: ALPHA, until: T }] })
  })

  it('is not dropped by the gone rule before its time; the mark is, after it, by the same rule', () => {
    const at = 10 * EXCLUDED_GONE_AFTER_MS
    const { excluded } = setup([idleUntil(ALPHA, at)])
    for (let tick = 0; tick < at; tick += EXCLUDED_GONE_AFTER_MS / 2) {
      expect(excluded.observe(live(BETA), tick)).toBe(false)
    }
    expect(excluded.reply().excluded).toEqual([idleUntil(ALPHA, at)])
    expect(excluded.observe(live(BETA), at)).toBe(true)
    // The mark's absence counts from the time on, and an empty list restarts the count.
    expect(excluded.observe(live(BETA), at + 1)).toBe(false)
    expect(excluded.observe([], at + 2)).toBe(false)
    expect(excluded.observe(live(BETA), at + 3)).toBe(false)
    expect(excluded.observe(live(BETA), at + 3 + EXCLUDED_GONE_AFTER_MS - 1)).toBe(false)
    expect(excluded.reply().due).toHaveLength(1)
    expect(excluded.observe(live(BETA), at + 3 + EXCLUDED_GONE_AFTER_MS)).toBe(true)
    expect(excluded.reply().due).toEqual([])
  })

  it('excluded while idle and running before the time: back at once as returned, its time dropped', () => {
    const { excluded } = setup([idleUntil(ALPHA, T)])
    expect(excluded.observe([as(ALPHA, 'working')], T - 1000)).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [], returned: [ALPHA], due: [] })
    expect(excluded.observe([as(ALPHA, 'idle')], T)).toBe(false)
    expect(excluded.reply().due).toEqual([])
  })

  it('excluded while running and running before the time: stays out until the time', () => {
    const { excluded } = setup([{ sessionId: ALPHA, whileRunning: true, until: T }])
    expect(excluded.observe([as(ALPHA, 'working')], T - 1000)).toBe(false)
    expect(excluded.observe([as(ALPHA, 'waiting')], T - 1)).toBe(false)
    expect(excluded.reply().excluded).toEqual([{ sessionId: ALPHA, whileRunning: true, until: T }])
    expect(excluded.observe([as(ALPHA, 'working')], T)).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [], returned: [], due: [{ sessionId: ALPHA, until: T }] })
  })

  it('ends the mark on the jump, on Backspace, and when excluded again with or without a time, and stores it', () => {
    const mark = [{ sessionId: ALPHA, until: T }]
    const jump = setup([], mark)
    expect(jump.excluded.acknowledgeReturn(ALPHA)).toBe(true)
    expect(jump.excluded.acknowledgeReturn(ALPHA)).toBe(false)
    expect(jump.savedDue).toEqual([[]])

    const backspace = setup([], mark)
    expect(backspace.excluded.clearDue(ALPHA)).toBe(true)
    expect(backspace.excluded.clearDue(ALPHA)).toBe(false)
    expect(backspace.savedDue).toEqual([[]])

    const deleted = setup([], mark)
    expect(deleted.excluded.exclude(ALPHA, live(ALPHA))).toBe(true)
    expect(deleted.excluded.reply()).toEqual({ excluded: [idle(ALPHA)], returned: [], due: [] })

    const timed = setup([], mark)
    expect(timed.excluded.excludeUntil(ALPHA, T + 10, live(ALPHA), T)).toBe(true)
    expect(timed.excluded.reply()).toEqual({ excluded: [idleUntil(ALPHA, T + 10)], returned: [], due: [] })
  })

  it('Backspace ends only the due mark, not a returned one', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe([as(ALPHA, 'working')], 0)
    expect(excluded.clearDue(ALPHA)).toBe(false)
    expect(excluded.reply().returned).toEqual([ALPHA])
  })

  it('keeps the finish of a due session quiet while it is from before the time, not one after it', () => {
    const { excluded } = setup([idle(BETA)], [{ sessionId: ALPHA, until: T }])
    expect([...excluded.quietFinishes([{ sessionId: ALPHA, status: 'idle', stoppedAt: T - 5000 }])]).toEqual([BETA, ALPHA])
    expect([...excluded.quietFinishes([{ sessionId: ALPHA, status: 'idle' }])]).toEqual([BETA, ALPHA])
    expect([...excluded.quietFinishes([{ sessionId: ALPHA, status: 'idle', stoppedAt: T + 1 }])]).toEqual([BETA])
  })

  it('passes the weekly reset on in the reply when it is set', () => {
    const reset = { weekday: 4, hour: 7, minute: 0 }
    expect(setup([], [], reset).excluded.reply().weeklyReset).toEqual(reset)
    expect('weeklyReset' in setup().excluded.reply()).toBe(false)
  })
})
