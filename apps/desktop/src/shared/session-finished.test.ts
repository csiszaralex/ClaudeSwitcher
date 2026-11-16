import { describe, expect, it } from 'vitest'
import { acknowledgeFinish, finishState, hasFinished } from './session-finished.js'

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

const SESSION_ID = '6f1c2a3e-0000-4000-8000-000000000011'
const finished = (stoppedAt: number) => ({ sessionId: SESSION_ID, status: 'idle' as const, stoppedAt })

describe('acknowledgeFinish', () => {
  it('records the stoppedAt the user has seen', () => {
    const seen = new Map<string, number>()
    acknowledgeFinish(seen, finished(5_000))
    expect(seen.get(SESSION_ID)).toBe(5_000)
  })

  it('records nothing for a session without a stoppedAt', () => {
    const seen = new Map<string, number>()
    acknowledgeFinish(seen, { sessionId: SESSION_ID })
    expect(seen.size).toBe(0)
  })
})

describe('finishState', () => {
  it('is unseen for a finish nobody has acknowledged', () => {
    expect(finishState(finished(5_000), new Map())).toBe('unseen')
  })

  it('is seen once that stoppedAt is acknowledged', () => {
    const seen = new Map<string, number>()
    acknowledgeFinish(seen, finished(5_000))
    expect(finishState(finished(5_000), seen)).toBe('seen')
  })

  it('is unseen again for a new stoppedAt after a seen one', () => {
    const seen = new Map<string, number>()
    acknowledgeFinish(seen, finished(5_000))
    expect(finishState(finished(9_000), seen)).toBe('unseen')
  })

  it('is none for a session that has not finished, seen or not', () => {
    const seen = new Map([[SESSION_ID, 5_000]])
    expect(finishState({ sessionId: SESSION_ID, status: 'idle' }, seen)).toBe('none')
    expect(finishState({ ...finished(5_000), status: 'working' }, seen)).toBe('none')
  })
})
