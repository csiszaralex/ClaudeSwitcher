import { describe, expect, it } from 'vitest'
import {
  AUTO_ACCEPT_HOLD_MS,
  autoTagText,
  autoTagTitle,
  endsHold,
  holdSecondsLeft,
  holdText,
  isAutoAcceptKey,
  type AutoAcceptHold,
} from './auto-accept-hold.js'

const plain = { key: 'A', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }

describe('isAutoAcceptKey', () => {
  it('is Shift+A, whatever Caps Lock does to the letter', () => {
    expect(isAutoAcceptKey(plain)).toBe(true)
    expect(isAutoAcceptKey({ ...plain, key: 'a' })).toBe(true)
  })

  it('is not a plain a: that stays the allow letter', () => {
    expect(isAutoAcceptKey({ ...plain, key: 'a', shiftKey: false })).toBe(false)
  })

  it('is not Shift+A with Ctrl, Alt or Meta', () => {
    expect(isAutoAcceptKey({ ...plain, ctrlKey: true })).toBe(false)
    expect(isAutoAcceptKey({ ...plain, altKey: true })).toBe(false)
    expect(isAutoAcceptKey({ ...plain, metaKey: true })).toBe(false)
  })

  it('is no other letter', () => {
    expect(isAutoAcceptKey({ ...plain, key: 'D' })).toBe(false)
  })
})

describe('endsHold', () => {
  it('ends on the release of the A or the Shift, not of another key', () => {
    expect(endsHold({ key: 'a' })).toBe(true)
    expect(endsHold({ key: 'A' })).toBe(true)
    expect(endsHold({ key: 'Shift' })).toBe(true)
    expect(endsHold({ key: 'Control' })).toBe(false)
  })
})

describe('the countdown', () => {
  const hold: AutoAcceptHold = { sessionId: '6f1c2a3e-0000-4000-8000-000000000091', turnOn: true, startedAt: 1_000 }

  it('counts the whole seconds left, rounded up, down to 0 once due', () => {
    expect(AUTO_ACCEPT_HOLD_MS).toBe(3000)
    expect(holdSecondsLeft(hold, 1_000)).toBe(3)
    expect(holdSecondsLeft(hold, 2_001)).toBe(2)
    expect(holdSecondsLeft(hold, 3_999)).toBe(1)
    expect(holdSecondsLeft(hold, 4_000)).toBe(0)
    expect(holdSecondsLeft(hold, 9_000)).toBe(0)
  })

  it('says whether it turns the mode on or off, with no dash inside the sentence', () => {
    const on = holdText(hold, 1_000)
    const off = holdText({ ...hold, turnOn: false }, 2_500)
    expect(on).toBe('Automatikus engedélyezés bekapcsolása: még 3 mp, tartsd lenyomva')
    expect(off).toBe('Automatikus engedélyezés kikapcsolása: még 2 mp, tartsd lenyomva')
    for (const text of [on, off, autoTagTitle(4)]) expect(text).not.toMatch(/[–—]/)
  })
})

describe('the tag', () => {
  it('shows the count of requests the mode allowed', () => {
    expect(autoTagText(0)).toBe('auto 0')
    expect(autoTagText(12)).toBe('auto 12')
    expect(autoTagTitle(12)).toContain('12 kérést')
  })
})
