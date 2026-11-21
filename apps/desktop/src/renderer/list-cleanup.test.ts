import { describe, expect, it } from 'vitest'
import { isClearFinishKey, showsFinishMark } from './list-cleanup.js'
import type { MarkerTone } from './session-marker.js'

const key = (name: string, extra: Partial<{ repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
  key: name,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
})

describe('isClearFinishKey', () => {
  it('is a plain Backspace', () => {
    expect(isClearFinishKey(key('Backspace'))).toBe(true)
  })

  it('is not with a modifier, held down, or another key', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'repeat'] as const) {
      expect(isClearFinishKey(key('Backspace', { [modifier]: true }))).toBe(false)
    }
    for (const other of ['Delete', 'b', ' ', 'Enter']) expect(isClearFinishKey(key(other))).toBe(false)
  })
})

describe('showsFinishMark', () => {
  const SESSION = { sessionId: '6f1c2a3e-0000-4000-8000-000000000041' }
  const row = (tone: MarkerTone) => ({ session: SESSION, marker: { tone } })

  it('is true for the green and the blue ✓', () => {
    expect(showsFinishMark(row('done'))).toBe(true)
    expect(showsFinishMark(row('seen'))).toBe(true)
  })

  it('is false for every other marker, the usage limit included', () => {
    for (const tone of ['waiting', 'choice', 'released', 'working', 'waits-on', 'limit', 'idle'] as const) {
      expect(showsFinishMark(row(tone))).toBe(false)
    }
  })

  it('is false for a row without a session', () => {
    expect(showsFinishMark({ session: undefined, marker: { tone: 'done' } })).toBe(false)
  })
})
