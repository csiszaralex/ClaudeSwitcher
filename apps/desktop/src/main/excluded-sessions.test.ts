import { describe, expect, it } from 'vitest'
import { EXCLUDED_GONE_AFTER_MS, createExcludedSessions } from './excluded-sessions.js'

// Invented session ids in the registry's UUID shape.
const ALPHA = '6f1c2a3e-0000-4000-8000-000000000061'
const BETA = '6f1c2a3e-0000-4000-8000-000000000062'
const GAMMA = '6f1c2a3e-0000-4000-8000-000000000063'
const live = (...ids: string[]) => ids.map((sessionId) => ({ sessionId }))

/** The excluded list with a recorder of what it persisted. */
function setup(initial: string[] = []) {
  const saved: string[][] = []
  const excluded = createExcludedSessions({ initial, persist: (ids) => saved.push([...ids]) })
  return { excluded, saved }
}

describe('createExcludedSessions: exclude and include', () => {
  it('starts with the stored ids', () => {
    const { excluded, saved } = setup([ALPHA, BETA])
    expect(excluded.ids()).toEqual([ALPHA, BETA])
    expect(excluded.set().has(BETA)).toBe(true)
    expect(saved).toEqual([])
  })

  it('excludes a live session and stores the list', () => {
    const { excluded, saved } = setup()
    expect(excluded.exclude(ALPHA, live(ALPHA, BETA))).toBe(true)
    expect(excluded.ids()).toEqual([ALPHA])
    expect(saved).toEqual([[ALPHA]])
  })

  it('does not exclude a session the daemon does not list now: a row without a session, or one that ended meanwhile', () => {
    const { excluded, saved } = setup()
    expect(excluded.exclude(GAMMA, live(ALPHA))).toBe(false)
    expect(excluded.exclude(GAMMA, [])).toBe(false)
    expect(excluded.ids()).toEqual([])
    expect(saved).toEqual([])
  })

  it('is idempotent: Delete pressed twice before the reply excludes once', () => {
    const { excluded, saved } = setup()
    expect(excluded.exclude(ALPHA, live(ALPHA))).toBe(true)
    expect(excluded.exclude(ALPHA, live(ALPHA))).toBe(false)
    expect(saved).toEqual([[ALPHA]])
  })

  it('brings a session back, once, also when it is not live any more', () => {
    const { excluded, saved } = setup([ALPHA, BETA])
    expect(excluded.include(ALPHA)).toBe(true)
    expect(excluded.include(ALPHA)).toBe(false)
    expect(excluded.include(GAMMA)).toBe(false)
    expect(excluded.ids()).toEqual([BETA])
    expect(saved).toEqual([[BETA]])
  })
})

describe('createExcludedSessions: dropping the ids of gone sessions', () => {
  it('drops an id missing for EXCLUDED_GONE_AFTER_MS without a break, and stores the list', () => {
    const { excluded, saved } = setup([ALPHA, BETA])
    expect(excluded.observe(live(BETA), 0)).toBe(false)
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS - 1)).toBe(false)
    expect(excluded.ids()).toEqual([ALPHA, BETA])
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)).toBe(true)
    expect(excluded.ids()).toEqual([BETA])
    expect(saved).toEqual([[BETA]])
  })

  it('keeps an id whose session comes back before that, and counts again from its next absence', () => {
    const { excluded } = setup([ALPHA])
    excluded.observe(live(BETA), 0)
    excluded.observe(live(ALPHA, BETA), EXCLUDED_GONE_AFTER_MS - 1)
    excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)
    expect(excluded.observe(live(BETA), 2 * EXCLUDED_GONE_AFTER_MS - 1)).toBe(false)
    expect(excluded.ids()).toEqual([ALPHA])
  })

  it('never drops from an empty list, and an empty list restarts every count', () => {
    // The daemon's list is empty before its first scan, and while the process probe has no snapshot.
    const { excluded, saved } = setup([ALPHA])
    expect(excluded.observe([], 0)).toBe(false)
    expect(excluded.observe([], 10 * EXCLUDED_GONE_AFTER_MS)).toBe(false)
    excluded.observe(live(BETA), 0)
    excluded.observe([], EXCLUDED_GONE_AFTER_MS / 2)
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)).toBe(false)
    expect(excluded.ids()).toEqual([ALPHA])
    expect(saved).toEqual([])
  })

  it('does not count an id brought back and excluded again from its old absence', () => {
    const { excluded } = setup([ALPHA])
    excluded.observe(live(BETA), 0)
    excluded.include(ALPHA)
    excluded.exclude(ALPHA, live(ALPHA))
    // Missing again only from here on.
    excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS)
    expect(excluded.observe(live(BETA), EXCLUDED_GONE_AFTER_MS + 1)).toBe(false)
    expect(excluded.ids()).toEqual([ALPHA])
  })
})
