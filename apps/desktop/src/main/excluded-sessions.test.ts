import type { SessionStatus } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
import type { ExcludedEntry } from '../shared/excluded-sessions.js'
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

/** The excluded list with a recorder of what it persisted and logged. */
function setup(initial: ExcludedEntry[] = []) {
  const saved: ExcludedEntry[][] = []
  const logged: string[] = []
  const excluded = createExcludedSessions({
    initial,
    persist: (entries) => saved.push(entries.map((entry) => ({ ...entry }))),
    log: (line) => logged.push(line),
  })
  return { excluded, saved, logged }
}

describe('createExcludedSessions: exclude and include', () => {
  it('starts with the stored entries and no returned session', () => {
    const { excluded, saved } = setup([idle(ALPHA), running(BETA)])
    expect(excluded.reply()).toEqual({ excluded: [idle(ALPHA), running(BETA)], returned: [] })
    expect(excluded.set().has(BETA)).toBe(true)
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
    expect(excluded.reply()).toEqual({ excluded: [idle(BETA)], returned: [ALPHA] })
    expect(excluded.set().has(ALPHA)).toBe(false)
    expect(saved).toEqual([[idle(BETA)]])
    expect(logged).toEqual([`[claudeswitcher] excluded session ${ALPHA} started running: back in the list`])
    // Nothing changes on the next tick.
    expect(excluded.observe([as(ALPHA, 'working'), as(BETA, 'idle')], 2000)).toBe(false)
  })

  it('brings back a session excluded while idle once it starts waiting', () => {
    const { excluded } = setup([idle(ALPHA)])
    expect(excluded.observe([as(ALPHA, 'waiting')], 0)).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [], returned: [ALPHA] })
  })

  it('never brings back a session excluded while working or waiting, also after an idle phase and a new run', () => {
    const { excluded, saved, logged } = setup()
    excluded.exclude(ALPHA, [as(ALPHA, 'working'), as(BETA, 'waiting')])
    excluded.exclude(BETA, [as(ALPHA, 'working'), as(BETA, 'waiting')])
    for (const [status, at] of [['working', 0], ['idle', 1000], ['waiting', 2000], ['idle', 3000], ['working', 4000]] as const) {
      expect(excluded.observe([as(ALPHA, status), as(BETA, status)], at)).toBe(false)
    }
    expect(excluded.reply()).toEqual({ excluded: [running(ALPHA), running(BETA)], returned: [] })
    expect(saved).toHaveLength(2)
    expect(logged).toEqual([])
  })

  it('ends the mark on the jump, once', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe([as(ALPHA, 'working')], 0)
    expect(excluded.acknowledgeReturn(ALPHA)).toBe(true)
    expect(excluded.acknowledgeReturn(ALPHA)).toBe(false)
    expect(excluded.acknowledgeReturn(BETA)).toBe(false)
    expect(excluded.reply()).toEqual({ excluded: [], returned: [] })
  })

  it('ends the mark when the session is excluded again, now as excluded while running', () => {
    const { excluded } = setup([idle(ALPHA)])
    excluded.observe([as(ALPHA, 'working')], 0)
    expect(excluded.exclude(ALPHA, [as(ALPHA, 'working')])).toBe(true)
    expect(excluded.reply()).toEqual({ excluded: [running(ALPHA)], returned: [] })
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
