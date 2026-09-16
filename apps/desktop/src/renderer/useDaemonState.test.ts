import { describe, expect, it } from 'vitest'
import { retryDelayMs } from './useDaemonState.js'

describe('retryDelayMs', () => {
  it('backs off exponentially from a quarter second', () => {
    expect(retryDelayMs(1)).toBe(250)
    expect(retryDelayMs(2)).toBe(500)
    expect(retryDelayMs(3)).toBe(1000)
  })

  it('caps the wait at ten seconds so a dead daemon is not hammered', () => {
    expect(retryDelayMs(99)).toBe(10_000)
  })
})
