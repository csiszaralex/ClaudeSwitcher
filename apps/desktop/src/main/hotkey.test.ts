import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOTKEY } from '../shared/settings.js'
import type { HotkeyRegistration } from '../shared/hotkey-status.js'
import { hotkeyLogText, registerHotkey, registerHotkeyOrDefault, switchHotkey, type RegisterAccelerator } from './hotkey.js'

/** A fake `globalShortcut.register`: false for the `taken` combinations, throws for the `invalid` ones. */
function fakeRegister(options: { taken?: string[]; invalid?: string[] } = {}): {
  register: RegisterAccelerator
  calls: string[]
} {
  const calls: string[] = []
  return {
    register: (accelerator) => {
      calls.push(accelerator)
      if (options.invalid?.includes(accelerator) === true) throw new Error(`Error processing argument: ${accelerator}`)
      return options.taken?.includes(accelerator) !== true
    },
    calls,
  }
}

const noop = (): void => undefined

describe('registerHotkey', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports a registered accelerator', () => {
    expect(registerHotkey(fakeRegister().register, 'F9', noop)).toBe('registered')
  })

  it('reports an accelerator another application holds as taken', () => {
    expect(registerHotkey(fakeRegister({ taken: ['F9'] }).register, 'F9', noop)).toBe('taken')
  })

  it('reports an accelerator Electron cannot parse as invalid instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeRegister({ invalid: ['Shift+Alt+Spcae'] })
    expect(registerHotkey(fake.register, 'Shift+Alt+Spcae', noop)).toBe('invalid')
  })
})

describe('registerHotkeyOrDefault', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers only the configured accelerator when it works', () => {
    const fake = fakeRegister()
    expect(registerHotkeyOrDefault(fake.register, 'F9', noop)).toEqual<HotkeyRegistration>({
      requested: 'F9',
      status: 'registered',
    })
    expect(fake.calls).toEqual(['F9'])
  })

  it('does not fall back when the accelerator is only taken', () => {
    const fake = fakeRegister({ taken: ['F9'] })
    expect(registerHotkeyOrDefault(fake.register, 'F9', noop)).toEqual<HotkeyRegistration>({
      requested: 'F9',
      status: 'taken',
    })
    expect(fake.calls).toEqual(['F9'])
  })

  it('registers the default accelerator when the configured one is invalid', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeRegister({ invalid: ['Shift+Alt+Spcae'] })
    expect(registerHotkeyOrDefault(fake.register, 'Shift+Alt+Spcae', noop)).toEqual<HotkeyRegistration>({
      requested: 'Shift+Alt+Spcae',
      status: 'invalid',
      fallback: { accelerator: DEFAULT_HOTKEY, status: 'registered' },
    })
    expect(fake.calls).toEqual(['Shift+Alt+Spcae', DEFAULT_HOTKEY])
  })

  it('reports a default that is taken as well', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeRegister({ invalid: ['bad'], taken: [DEFAULT_HOTKEY] })
    expect(registerHotkeyOrDefault(fake.register, 'bad', noop).fallback).toEqual({
      accelerator: DEFAULT_HOTKEY,
      status: 'taken',
    })
  })
})

describe('switchHotkey', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A fake `globalShortcut` pair that logs every call in one list, so the order shows. */
  function fakeShortcuts(options: { taken?: string[]; invalid?: string[] } = {}): {
    deps: { register: RegisterAccelerator; unregister: (accelerator: string) => void }
    calls: string[]
  } {
    const calls: string[] = []
    const fake = fakeRegister(options)
    return {
      deps: {
        register: (accelerator, handler) => {
          calls.push(`register ${accelerator}`)
          return fake.register(accelerator, handler)
        },
        unregister: (accelerator) => {
          calls.push(`unregister ${accelerator}`)
        },
      },
      calls,
    }
  }

  it('keeps the old hotkey when the new one is taken', () => {
    const { deps, calls } = fakeShortcuts({ taken: ['F9'] })
    const result = switchHotkey(deps, 'F8', 'F9', noop)
    expect(result).toMatchObject({ switched: false, attempted: 'taken' })
    expect(calls.at(-1)).toBe('register F8')
    expect(result.registration).toEqual<HotkeyRegistration>({ requested: 'F8', status: 'registered' })
  })

  it('keeps the old hotkey when the new one is invalid', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps, calls } = fakeShortcuts({ invalid: ['Shift+Alt+Spcae'] })
    const result = switchHotkey(deps, 'F8', 'Shift+Alt+Spcae', noop)
    expect(result).toMatchObject({ switched: false, attempted: 'invalid' })
    expect(calls.at(-1)).toBe('register F8')
    expect(result.registration).toEqual<HotkeyRegistration>({ requested: 'F8', status: 'registered' })
  })

  it('switches when the new one registers', () => {
    const { deps, calls } = fakeShortcuts()
    const result = switchHotkey(deps, 'F8', 'F9', noop)
    expect(calls).toEqual(['unregister F8', 'register F9'])
    expect(result).toEqual({ switched: true, registration: { requested: 'F9', status: 'registered' } })
  })

  it('the same accelerator is a no-op', () => {
    const { deps, calls } = fakeShortcuts()
    const result = switchHotkey(deps, 'F8', 'F8', noop)
    expect(calls).toEqual([])
    expect(result).toEqual({ switched: true, registration: { requested: 'F8', status: 'registered' } })
  })
})

describe('hotkeyLogText', () => {
  it('describes each outcome for the startup log', () => {
    expect(hotkeyLogText({ requested: 'F9', status: 'registered' })).toBe('hotkey F9 registered')
    expect(hotkeyLogText({ requested: 'F9', status: 'taken' })).toBe(
      'hotkey F9 NOT registered (taken by another application)',
    )
    expect(
      hotkeyLogText({ requested: 'x', status: 'invalid', fallback: { accelerator: DEFAULT_HOTKEY, status: 'registered' } }),
    ).toBe(`hotkey x INVALID; default ${DEFAULT_HOTKEY} registered`)
  })
})
