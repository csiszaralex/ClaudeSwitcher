import { describe, expect, it } from 'vitest'
import { failedState, nextBoundaryState, type BoundaryState } from './error-boundary-state.js'

const healthy: BoundaryState = { message: undefined, failedAt: undefined }

describe('failedState', () => {
  it('keeps the message of an Error, and stringifies anything else', () => {
    expect(failedState(new Error('boom')).message).toBe('boom')
    expect(failedState('plain').message).toBe('plain')
    expect(failedState(new Error('boom')).failedAt).toBeUndefined()
  })
})

describe('nextBoundaryState', () => {
  it('leaves a healthy boundary alone', () => {
    expect(nextBoundaryState(healthy, 3)).toBe(healthy)
  })

  it('records the reset key the failure happened at', () => {
    expect(nextBoundaryState(failedState(new Error('boom')), 3)).toEqual({ message: 'boom', failedAt: 3 })
  })

  it('stays down while the key is the one it failed at, so a failing state cannot loop', () => {
    const down = nextBoundaryState(failedState(new Error('boom')), 3)
    expect(nextBoundaryState(down, 3)).toBe(down)
  })

  it('recovers on the next state message', () => {
    const down = nextBoundaryState(failedState(new Error('boom')), 3)
    expect(nextBoundaryState(down, 4)).toEqual(healthy)
  })

  it('fails again at the new key if the next render also throws, and waits for the message after that', () => {
    const recovered = nextBoundaryState(nextBoundaryState(failedState(new Error('a')), 3), 4)
    const downAgain = nextBoundaryState({ ...recovered, ...failedState(new Error('b')) }, 4)
    expect(downAgain).toEqual({ message: 'b', failedAt: 4 })
    expect(nextBoundaryState(downAgain, 4)).toBe(downAgain)
    expect(nextBoundaryState(downAgain, 5)).toEqual(healthy)
  })

  it('never recovers without a reset key (a boundary that is remounted by its React key instead)', () => {
    const down = nextBoundaryState(failedState(new Error('boom')), undefined)
    expect(down.message).toBe('boom')
    expect(nextBoundaryState(down, undefined)).toBe(down)
  })
})
