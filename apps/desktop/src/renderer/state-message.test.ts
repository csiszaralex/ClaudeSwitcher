import { describe, expect, it } from 'vitest'
import { parseStateMessage, sanitizeState } from './state-message.js'

describe('parseStateMessage', () => {
  it('returns the state carried by a well-formed state message', () => {
    const message = JSON.stringify({ type: 'state', payload: { sessions: [], rateLimits: {} } })
    expect(parseStateMessage(message)).toEqual({ sessions: [], rateLimits: {} })
  })

  it('ignores messages that are not state updates', () => {
    expect(parseStateMessage(JSON.stringify({ type: 'other', payload: {} }))).toBeUndefined()
    expect(parseStateMessage(JSON.stringify({ type: 'state', payload: { sessions: 'no' } }))).toBeUndefined()
  })

  it('never throws on garbage', () => {
    for (const garbage of ['not json', '', 'null', '42', '[]', undefined]) {
      expect(() => parseStateMessage(garbage)).not.toThrow()
      expect(parseStateMessage(garbage)).toBeUndefined()
    }
  })

  it('drops a malformed session instead of handing it to the renderer', () => {
    // Enélkül az App a `view.sessionId`-n dobna, és mivel az ErrorBoundary nem áll vissza
    // magától, az overlay onnantól véglegesen hibaszöveget mutatna.
    const message = JSON.stringify({
      type: 'state',
      payload: { sessions: [null, { sessionId: 'a' }, 'nope', {}], rateLimits: {} },
    })
    expect(parseStateMessage(message)?.sessions).toEqual([{ sessionId: 'a' }])
  })
})

describe('sanitizeState', () => {
  it('drops a null rate-limit window, which an undefined check would let through', () => {
    // `five_hour !== undefined` egy null-ra IGAZ, és a `.used_percentage` utána dob.
    const clean = sanitizeState({
      sessions: [],
      rateLimits: { five_hour: null, seven_day: { used_percentage: 4, resets_at: 1 } },
    })
    expect(clean?.rateLimits.five_hour).toBeUndefined()
    expect(clean?.rateLimits.seven_day).toEqual({ used_percentage: 4, resets_at: 1 })
  })

  it('rejects a payload whose containers are the wrong type', () => {
    expect(sanitizeState({ sessions: 'no', rateLimits: {} })).toBeUndefined()
    expect(sanitizeState({ sessions: [], rateLimits: null })).toBeUndefined()
    expect(sanitizeState(undefined)).toBeUndefined()
  })

  it('never throws, whatever it is handed', () => {
    for (const garbage of [null, 42, 'text', [], { sessions: [undefined], rateLimits: {} }]) {
      expect(() => sanitizeState(garbage)).not.toThrow()
    }
  })
})
