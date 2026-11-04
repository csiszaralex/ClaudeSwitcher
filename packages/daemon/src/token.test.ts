import { describe, expect, it } from 'vitest'
import { createToken, isToken } from './token.js'

describe('daemon token', () => {
  it('creates 32 lowercase hex digits, a different one each time', () => {
    const token = createToken()
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(createToken()).not.toBe(token)
  })

  it('accepts exactly the created format', () => {
    expect(isToken(createToken())).toBe(true)
    expect(isToken('0123456789abcdef0123456789abcdef')).toBe(true)
    for (const value of ['', 'not a token', '0123456789abcdef', '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef0123456789abcdef0']) {
      expect(isToken(value)).toBe(false)
    }
  })
})
