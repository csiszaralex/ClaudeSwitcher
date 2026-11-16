import { describe, expect, it } from 'vitest'
import { hasFinished } from './session-finished.js'

describe('hasFinished', () => {
  it('is true for an idle session with a stoppedAt', () => {
    expect(hasFinished({ status: 'idle', stoppedAt: 5_000 })).toBe(true)
  })

  it('is false without a stoppedAt', () => {
    expect(hasFinished({ status: 'idle' })).toBe(false)
    expect(hasFinished({ status: 'idle', stoppedAt: undefined })).toBe(false)
  })

  it('is false for a session that runs or waits again, even with a stale stoppedAt', () => {
    expect(hasFinished({ status: 'working', stoppedAt: 5_000 })).toBe(false)
    expect(hasFinished({ status: 'waiting', stoppedAt: 5_000 })).toBe(false)
  })
})
