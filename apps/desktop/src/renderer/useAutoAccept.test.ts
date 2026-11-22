import { describe, expect, it } from 'vitest'
import { readAutoAccept } from './useAutoAccept.js'

const SESSION_A = '6f1c2a3e-0000-4000-8000-000000000081'
const SESSION_B = '6f1c2a3e-0000-4000-8000-000000000082'

describe('readAutoAccept', () => {
  it('reads the sessions and their counts', () => {
    expect([...readAutoAccept([{ sessionId: SESSION_A, allowed: 0 }, { sessionId: SESSION_B, allowed: 3 }])]).toEqual([
      [SESSION_A, 0],
      [SESSION_B, 3],
    ])
  })

  it('drops an entry without a session id or a whole, non-negative count, and keeps the rest', () => {
    const raw = [
      { sessionId: '', allowed: 1 },
      { sessionId: SESSION_A, allowed: -1 },
      { sessionId: SESSION_A, allowed: 1.5 },
      { sessionId: SESSION_A, allowed: '2' },
      { allowed: 2 },
      null,
      SESSION_A,
      { sessionId: SESSION_B, allowed: 2 },
    ]
    expect([...readAutoAccept(raw)]).toEqual([[SESSION_B, 2]])
  })

  it('gives an empty map for anything that is not an array', () => {
    for (const raw of [undefined, null, {}, SESSION_A, 7]) expect(readAutoAccept(raw).size).toBe(0)
  })
})
