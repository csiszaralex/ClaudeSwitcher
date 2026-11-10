import { describe, expect, it } from 'vitest'
import {
  armUntil,
  isArmed,
  recentlyTyped,
  SHORTCUT_ARM_MS,
  shortcutAllowed,
  TYPING_COOLDOWN_MS,
  type ShortcutClock,
  type ShortcutKey,
} from './key-guard.js'

const plainKey: ShortcutKey = { repeat: false, ctrlKey: false, altKey: false, metaKey: false, typingTarget: false }
const NOW = 100_000
// A panel armed long ago, and no typing into a text field ever: every other rule measures against this.
const calm: ShortcutClock = { armedAt: NOW - 10_000, lastTypedAt: undefined, now: NOW }

describe('the constants', () => {
  it('arms a panel after about 400 ms, and waits 1.5 s after typing', () => {
    expect(SHORTCUT_ARM_MS).toBe(400)
    expect(TYPING_COOLDOWN_MS).toBe(1500)
  })
})

describe('armUntil / isArmed', () => {
  it('arms SHORTCUT_ARM_MS after the given moment', () => {
    expect(armUntil(NOW)).toBe(NOW + SHORTCUT_ARM_MS)
  })

  it('is unarmed before armedAt and armed from armedAt on', () => {
    const armedAt = armUntil(NOW)
    expect(isArmed(armedAt, NOW)).toBe(false)
    expect(isArmed(armedAt, armedAt - 1)).toBe(false)
    expect(isArmed(armedAt, armedAt)).toBe(true)
    expect(isArmed(armedAt, armedAt + 1)).toBe(true)
  })
})

describe('shortcutAllowed', () => {
  it('lets a plain, single key through on an armed panel when nobody typed', () => {
    expect(shortcutAllowed(plainKey, calm)).toBe(true)
  })

  it('always ignores an auto-repeated key, so a held A cannot decide the next request', () => {
    expect(shortcutAllowed({ ...plainKey, repeat: true }, calm)).toBe(false)
  })

  it('ignores Ctrl, Alt and Meta (AltGr on the Hungarian layout arrives as Ctrl+Alt)', () => {
    expect(shortcutAllowed({ ...plainKey, ctrlKey: true }, calm)).toBe(false)
    expect(shortcutAllowed({ ...plainKey, altKey: true }, calm)).toBe(false)
    expect(shortcutAllowed({ ...plainKey, metaKey: true }, calm)).toBe(false)
    expect(shortcutAllowed({ ...plainKey, ctrlKey: true, altKey: true }, calm)).toBe(false)
  })

  it('ignores a key whose target is a text field: the letter belongs to the field', () => {
    expect(shortcutAllowed({ ...plainKey, typingTarget: true }, calm)).toBe(false)
  })

  it('ignores every key before the panel is armed, and accepts it from armedAt on', () => {
    const armedAt = armUntil(NOW)
    expect(shortcutAllowed(plainKey, { ...calm, armedAt, now: NOW })).toBe(false)
    expect(shortcutAllowed(plainKey, { ...calm, armedAt, now: armedAt - 1 })).toBe(false)
    expect(shortcutAllowed(plainKey, { ...calm, armedAt, now: armedAt })).toBe(true)
  })

  it('waits TYPING_COOLDOWN_MS after the last keystroke into a text field', () => {
    // The field vanished under the user's hand (the request was settled elsewhere): focus is on the
    // body, and the typing goes on.
    const lastTypedAt = NOW - TYPING_COOLDOWN_MS + 1
    expect(shortcutAllowed(plainKey, { ...calm, lastTypedAt })).toBe(false)
    expect(shortcutAllowed(plainKey, { ...calm, lastTypedAt: NOW })).toBe(false)
    expect(shortcutAllowed(plainKey, { ...calm, lastTypedAt: NOW - TYPING_COOLDOWN_MS })).toBe(true)
  })

  it('needs every rule to pass: an armed panel does not excuse fresh typing, and old typing does not excuse arming', () => {
    expect(shortcutAllowed(plainKey, { armedAt: NOW - 1, lastTypedAt: NOW - 10, now: NOW })).toBe(false)
    expect(shortcutAllowed(plainKey, { armedAt: NOW + 1, lastTypedAt: NOW - 10_000, now: NOW })).toBe(false)
    expect(shortcutAllowed({ ...plainKey, repeat: true }, { armedAt: 0, lastTypedAt: undefined, now: NOW })).toBe(
      false,
    )
  })
})

describe('recentlyTyped', () => {
  it('is true within TYPING_COOLDOWN_MS of the last keystroke into a text field, false after and when nobody typed', () => {
    expect(recentlyTyped(undefined, NOW)).toBe(false)
    expect(recentlyTyped(NOW - TYPING_COOLDOWN_MS + 1, NOW)).toBe(true)
    expect(recentlyTyped(NOW - TYPING_COOLDOWN_MS, NOW)).toBe(false)
  })
})
