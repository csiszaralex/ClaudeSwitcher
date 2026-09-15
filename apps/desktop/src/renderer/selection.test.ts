import { describe, expect, it } from 'vitest'
import { moveSelection, resolveSelectedIndex } from './selection.js'

describe('resolveSelectedIndex', () => {
  it('returns -1 for an empty list', () => {
    expect(resolveSelectedIndex([], 'a')).toBe(-1)
  })

  it('defaults to the first session when nothing is selected', () => {
    expect(resolveSelectedIndex(['a', 'b'], undefined)).toBe(0)
  })

  it('follows the selected session when the list re-sorts', () => {
    // A `b` az 1-es indexen volt; egy várakozni kezdő `c` felülre ugrik. Index
    // szerinti követéssel az Enter most az `a` ablakára ugrana.
    expect(resolveSelectedIndex(['c', 'a', 'b'], 'b')).toBe(2)
  })

  it('falls back to the first session when the selected one disappears', () => {
    expect(resolveSelectedIndex(['a', 'c'], 'b')).toBe(0)
  })
})

describe('moveSelection', () => {
  it('moves down and up by session, not by stale index', () => {
    expect(moveSelection(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(moveSelection(['a', 'b', 'c'], 'c', -1)).toBe('b')
  })

  it('stops at both ends of the list', () => {
    expect(moveSelection(['a', 'b'], 'b', 1)).toBe('b')
    expect(moveSelection(['a', 'b'], 'a', -1)).toBe('a')
  })

  it('returns undefined for an empty list rather than an invalid position', () => {
    // A javítás előtt ez a kiválasztást -1-re állította, ahol beragadt.
    expect(moveSelection([], undefined, 1)).toBeUndefined()
  })
})
