import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY } from './settings.js'
import { acceleratorFromKey } from './accelerator.js'

const NONE = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }

describe('acceleratorFromKey', () => {
  it('turns Shift+Alt+Space into the default hotkey', () => {
    const accelerator = acceleratorFromKey({ ...NONE, code: 'Space', shiftKey: true, altKey: true })
    expect(accelerator).toBe('Shift+Alt+Space')
    expect(accelerator).toBe(DEFAULT_HOTKEY)
  })

  it('names letters, digits, function keys and arrows the way Electron does', () => {
    expect(acceleratorFromKey({ ...NONE, code: 'KeyK', ctrlKey: true, shiftKey: true })).toBe('Control+Shift+K')
    expect(acceleratorFromKey({ ...NONE, code: 'Digit3', altKey: true })).toBe('Alt+3')
    expect(acceleratorFromKey({ ...NONE, code: 'F9' })).toBe('F9')
    expect(acceleratorFromKey({ ...NONE, code: 'F24', ctrlKey: true })).toBe('Control+F24')
    expect(acceleratorFromKey({ ...NONE, code: 'ArrowUp', altKey: true })).toBe('Alt+Up')
    expect(acceleratorFromKey({ ...NONE, code: 'Numpad7', ctrlKey: true })).toBe('Control+num7')
  })

  it('names a letter by its label in the active layout', () => {
    // Hungarian QWERTZ: the key labelled Z sits where the US layout has Y.
    expect(acceleratorFromKey({ ...NONE, code: 'KeyY', key: 'z', ctrlKey: true, shiftKey: true })).toBe('Control+Shift+Z')
    // AltGr (Control+Alt) turns the key into a symbol; the physical key is used then.
    expect(acceleratorFromKey({ ...NONE, code: 'KeyV', key: '@', ctrlKey: true, altKey: true })).toBe('Control+Alt+V')
  })

  it('gives nothing for a modifier alone', () => {
    for (const code of ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft', 'AltRight', 'MetaLeft']) {
      expect(acceleratorFromKey({ ...NONE, code, shiftKey: true, altKey: true })).toBeUndefined()
    }
  })

  it('gives nothing for a key that would get in the way of typing', () => {
    expect(acceleratorFromKey({ ...NONE, code: 'KeyK' })).toBeUndefined()
    expect(acceleratorFromKey({ ...NONE, code: 'KeyK', shiftKey: true })).toBeUndefined()
    expect(acceleratorFromKey({ ...NONE, code: 'Space' })).toBeUndefined()
  })

  it('gives nothing for a key it has no name for', () => {
    expect(acceleratorFromKey({ ...NONE, code: 'IntlBackslash', ctrlKey: true })).toBeUndefined()
    expect(acceleratorFromKey({ ...NONE, code: 'Fn', ctrlKey: true })).toBeUndefined()
  })

  it('orders the modifiers Control, Shift, Alt, Super', () => {
    expect(
      acceleratorFromKey({ code: 'KeyA', ctrlKey: true, shiftKey: true, altKey: true, metaKey: true }),
    ).toBe('Control+Shift+Alt+Super+A')
    expect(acceleratorFromKey({ ...NONE, code: 'KeyA', metaKey: true, altKey: true })).toBe('Alt+Super+A')
  })
})
