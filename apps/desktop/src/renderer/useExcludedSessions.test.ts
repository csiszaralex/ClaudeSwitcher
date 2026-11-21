import { describe, expect, it } from 'vitest'
import { readExcludedSessions } from './useExcludedSessions.js'

const SESSION_A = '6f1c2a3e-0000-4000-8000-000000000071'
const SESSION_B = '6f1c2a3e-0000-4000-8000-000000000072'

describe('readExcludedSessions', () => {
  it('reads the session ids', () => {
    expect([...readExcludedSessions([SESSION_A, SESSION_B])]).toEqual([SESSION_A, SESSION_B])
  })

  it('drops an item that is not a non-empty string and keeps the rest', () => {
    expect([...readExcludedSessions([SESSION_A, 42, '', null, [SESSION_B], SESSION_B])]).toEqual([SESSION_A, SESSION_B])
  })

  it('gives an empty set for anything that is not an array', () => {
    for (const raw of [undefined, null, {}, SESSION_A, 7]) expect(readExcludedSessions(raw).size).toBe(0)
  })
})
