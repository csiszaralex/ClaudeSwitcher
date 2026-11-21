import { describe, expect, it } from 'vitest'
import { seenFinishesReply, type SeenFinish } from '../shared/session-finished.js'
import { readSeenFinishes } from './useSeenFinishes.js'

const SESSION_A = '6f1c2a3e-0000-4000-8000-000000000021'
const SESSION_B = '6f1c2a3e-0000-4000-8000-000000000022'

describe('readSeenFinishes', () => {
  it('reads the [sessionId, stoppedAt, cleared] triples', () => {
    const seen = readSeenFinishes([
      [SESSION_A, 5_000, false],
      [SESSION_B, 9_000, true],
    ])
    expect([...seen]).toEqual([
      [SESSION_A, { stoppedAt: 5_000, cleared: false }],
      [SESSION_B, { stoppedAt: 9_000, cleared: true }],
    ])
  })

  it('reads back what the main process sends', () => {
    const sent = new Map<string, SeenFinish>([
      [SESSION_A, { stoppedAt: 5_000, cleared: true }],
      [SESSION_B, { stoppedAt: 9_000, cleared: false }],
    ])
    expect(readSeenFinishes(seenFinishesReply(sent))).toEqual(sent)
  })

  it('drops a malformed triple and keeps the rest', () => {
    const seen = readSeenFinishes([[SESSION_A, '5000', false], null, [42, 1, false], [SESSION_A, 5_000], [SESSION_B, 9_000, false]])
    expect([...seen]).toEqual([[SESSION_B, { stoppedAt: 9_000, cleared: false }]])
  })

  it('gives an empty map for anything that is not an array', () => {
    for (const raw of [undefined, null, {}, 'x', 7]) expect(readSeenFinishes(raw).size).toBe(0)
  })
})
