import { describe, expect, it } from 'vitest'
import { flatText, isRecord, lastPathSegment, nonEmptyString, truncate } from './guards.js'

describe('guards', () => {
  it('isRecord accepts plain objects and rejects arrays, null and primitives', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    for (const value of [[], [1], null, undefined, 'x', 1, true]) expect(isRecord(value)).toBe(false)
  })

  it('nonEmptyString passes a non-empty string through and nothing else', () => {
    expect(nonEmptyString('a')).toBe('a')
    expect(nonEmptyString(' ')).toBe(' ')
    for (const value of ['', null, undefined, 1, {}]) expect(nonEmptyString(value)).toBeUndefined()
  })

  it('flatText flattens whitespace and drops a blank result', () => {
    expect(flatText('  a\n\tb  ')).toBe('a b')
    expect(flatText(' \n ')).toBeUndefined()
    expect(flatText(3)).toBeUndefined()
  })

  it('truncate keeps a short text and cuts a long one to max with an ellipsis', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abcd', 3)).toBe('ab…')
    expect(truncate('', 3)).toBe('')
  })

  it('lastPathSegment takes the last segment on either separator', () => {
    expect(lastPathSegment('C:\\work\\repo\\')).toBe('repo')
    expect(lastPathSegment('/home/u/file.ts')).toBe('file.ts')
    expect(lastPathSegment('name')).toBe('name')
    expect(lastPathSegment('//')).toBeUndefined()
    expect(lastPathSegment('')).toBeUndefined()
  })
})
