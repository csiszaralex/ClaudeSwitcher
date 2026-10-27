import { describe, expect, it } from 'vitest'
import { matchesSecret } from './token-compare.js'

describe('matchesSecret', () => {
  it('accepts the exact secret', () => {
    expect(matchesSecret('Bearer 0123456789abcdef', 'Bearer 0123456789abcdef')).toBe(true)
  })

  it('refuses a value of the same length that differs anywhere', () => {
    expect(matchesSecret('Bearer 0123456789abcdee', 'Bearer 0123456789abcdef')).toBe(false)
    expect(matchesSecret('bearer 0123456789abcdef', 'Bearer 0123456789abcdef')).toBe(false)
  })

  it('refuses a shorter or longer value without throwing', () => {
    // A timingSafeEqual eltérő hosszú bufferekre dobna; a hossz-ellenőrzés előtte fut.
    expect(matchesSecret('Bearer 0123', 'Bearer 0123456789abcdef')).toBe(false)
    expect(matchesSecret('Bearer 0123456789abcdef0', 'Bearer 0123456789abcdef')).toBe(false)
  })

  it('refuses a missing or empty value', () => {
    expect(matchesSecret(undefined, 'secret')).toBe(false)
    expect(matchesSecret(null, 'secret')).toBe(false)
    expect(matchesSecret('', 'secret')).toBe(false)
  })

  it('compares bytes, so a non-ASCII value of equal character count is still refused', () => {
    expect(matchesSecret('é', 'e')).toBe(false)
  })
})
