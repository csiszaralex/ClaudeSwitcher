/**
 * Turns a key press captured for the hotkey into an Electron accelerator (`docs/api/accelerator.md`).
 * The main process reads the keys in the setup window's `before-input-event` (`captureStep`), so it
 * lives in `src/shared`. Works from `KeyboardEvent.code`, the physical key, because
 * `KeyboardEvent.key` changes with the modifiers (Shift+3 is `+` on a Hungarian layout, AltGr+V
 * is `@`). Letters are the exception: Windows names a letter key by its label in the active layout,
 * so on a Hungarian QWERTZ keyboard the key labelled Z has `code` `KeyY`. A plain letter in
 * `key` therefore wins. (Reasoned from the Windows virtual-key model, not measured on this machine.)
 */

export interface KeyPress {
  code: string
  /** `KeyboardEvent.key`; only a single plain letter is used from it. */
  key?: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

/** The accelerator name of the pressed key; `undefined` for a modifier or a key without a name. */
function keyName(code: string, key: string | undefined): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter !== null && key !== undefined && /^[a-z]$/i.test(key)) return key.toUpperCase()
  if (letter?.[1] !== undefined) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit?.[1] !== undefined) return digit[1]
  const numpad = /^Numpad([0-9])$/.exec(code)
  if (numpad?.[1] !== undefined) return `num${numpad[1]}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return NAMED_KEYS[code]
}

const isFunctionKey = (name: string): boolean => /^F[0-9]+$/.test(name)

/**
 * The accelerator for a key press, modifiers in the order Control, Shift, Alt, Super. `undefined`
 * when the press is not a usable global hotkey: a modifier alone, a key without a name, or a key
 * that would get in the way of typing everywhere, that is, anything but a function key without
 * Control, Alt or Super (Shift alone is not enough: Shift+K is a capital K).
 */
export function acceleratorFromKey(event: KeyPress): string | undefined {
  const name = keyName(event.code, event.key)
  if (name === undefined) return undefined
  if (!isFunctionKey(name) && !event.ctrlKey && !event.altKey && !event.metaKey) return undefined
  const modifiers = [
    event.ctrlKey ? 'Control' : undefined,
    event.shiftKey ? 'Shift' : undefined,
    event.altKey ? 'Alt' : undefined,
    event.metaKey ? 'Super' : undefined,
  ].filter((modifier) => modifier !== undefined)
  return [...modifiers, name].join('+')
}
