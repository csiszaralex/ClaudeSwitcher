import { describe, expect, it } from 'vitest'
import { readExcludedSessions } from './useExcludedSessions.js'

const SESSION_A = '6f1c2a3e-0000-4000-8000-000000000071'
const SESSION_B = '6f1c2a3e-0000-4000-8000-000000000072'
const SESSION_C = '6f1c2a3e-0000-4000-8000-000000000073'

/** The read value with its sets as arrays, for `toEqual`. */
function read(raw: unknown) {
  const { excluded, whileRunning, returned } = readExcludedSessions(raw)
  return { excluded: [...excluded], whileRunning: [...whileRunning], returned: [...returned] }
}

describe('readExcludedSessions', () => {
  it('reads the excluded sessions, those excluded while running, and the returned ones', () => {
    const reply = {
      excluded: [
        { sessionId: SESSION_A, whileRunning: false },
        { sessionId: SESSION_B, whileRunning: true },
      ],
      returned: [SESSION_C],
    }
    expect(read(reply)).toEqual({ excluded: [SESSION_A, SESSION_B], whileRunning: [SESSION_B], returned: [SESSION_C] })
  })

  it('drops a malformed item and keeps the rest', () => {
    const reply = {
      excluded: [42, null, { sessionId: SESSION_A }, { sessionId: '', whileRunning: true }, { sessionId: SESSION_B, whileRunning: true }],
      returned: [SESSION_C, '', 7, [SESSION_A]],
    }
    expect(read(reply)).toEqual({ excluded: [SESSION_B], whileRunning: [SESSION_B], returned: [SESSION_C] })
  })

  it('gives empty values for a reply that is not such an object, or a field that is not an array', () => {
    const empty = { excluded: [], whileRunning: [], returned: [] }
    for (const raw of [undefined, null, {}, SESSION_A, 7, [SESSION_A]]) expect(read(raw)).toEqual(empty)
    expect(read({ excluded: SESSION_A, returned: { 0: SESSION_C } })).toEqual(empty)
  })
})

describe('readExcludedSessions: times, due marks and the weekly reset', () => {
  it('reads the times of the timed entries, the due marks and the weekly reset', () => {
    const reply = {
      excluded: [
        { sessionId: SESSION_A, whileRunning: false, until: 2000 },
        { sessionId: SESSION_B, whileRunning: true },
      ],
      returned: [],
      due: [{ sessionId: SESSION_C, until: 1000 }],
      weeklyReset: { weekday: 4, hour: 7, minute: 0 },
    }
    const state = readExcludedSessions(reply)
    expect([...state.until]).toEqual([[SESSION_A, 2000]])
    expect([...state.due]).toEqual([[SESSION_C, 1000]])
    expect(state.weeklyReset).toEqual({ weekday: 4, hour: 7, minute: 0 })
  })

  it('drops an entry whose time is malformed, a malformed due mark, and a malformed weekly reset', () => {
    const reply = {
      excluded: [{ sessionId: SESSION_A, whileRunning: false, until: 'holnap' }],
      returned: [],
      due: [{ sessionId: SESSION_C }, { sessionId: SESSION_B, until: Number.NaN }],
      weeklyReset: { weekday: 9, hour: 7, minute: 0 },
    }
    const state = readExcludedSessions(reply)
    expect([...state.excluded]).toEqual([])
    expect([...state.due]).toEqual([])
    expect(state.weeklyReset).toBeUndefined()
    expect(readExcludedSessions({ excluded: [], returned: [] }).due.size).toBe(0)
  })
})
