import { describe, expect, it } from 'vitest'
import { parseStateMessage } from './state-message.js'

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
})
