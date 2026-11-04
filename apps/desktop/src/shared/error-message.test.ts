import { describe, expect, it } from 'vitest'
import { errorMessage } from './error-message.js'

describe('errorMessage', () => {
  it("takes an Error's message", () => {
    expect(errorMessage(new Error('a daemon nem válaszol'))).toBe('a daemon nem válaszol')
    expect(errorMessage(new TypeError('rossz típus'))).toBe('rossz típus')
  })

  it('turns anything else into a string', () => {
    expect(errorMessage('kész szöveg')).toBe('kész szöveg')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})
