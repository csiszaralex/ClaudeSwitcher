import { describe, expect, it } from 'vitest'
import { readSeenFinishes } from './useSeenFinishes.js'

const SESSION_A = '6f1c2a3e-0000-4000-8000-000000000021'
const SESSION_B = '6f1c2a3e-0000-4000-8000-000000000022'

describe('readSeenFinishes', () => {
  it('reads the [sessionId, stoppedAt] pairs', () => {
    const seen = readSeenFinishes([
      [SESSION_A, 5_000],
      [SESSION_B, 9_000],
    ])
    expect([...seen]).toEqual([
      [SESSION_A, 5_000],
      [SESSION_B, 9_000],
    ])
  })

  it('drops a malformed pair and keeps the rest', () => {
    const seen = readSeenFinishes([[SESSION_A, '5000'], null, [42, 1], [SESSION_B, 9_000]])
    expect([...seen]).toEqual([[SESSION_B, 9_000]])
  })

  it('gives an empty map for anything that is not an array', () => {
    for (const raw of [undefined, null, {}, 'x', 7]) expect(readSeenFinishes(raw).size).toBe(0)
  })
})
