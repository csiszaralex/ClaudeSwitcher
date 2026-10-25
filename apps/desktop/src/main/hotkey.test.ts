import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOTKEY } from './config.js'
import {
  hotkeyLabel,
  hotkeyLogText,
  registerHotkey,
  registerHotkeyOrDefault,
  type HotkeyRegistration,
  type RegisterAccelerator,
} from './hotkey.js'

/** Egy hamis `globalShortcut.register`: a `taken` kombinációkra false, az `invalid`-okra dob. */
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

describe('hotkeyLabel', () => {
  it('names the working accelerator', () => {
    expect(hotkeyLabel({ requested: 'F9', status: 'registered' })).toBe('Gyorsbillentyű: F9')
  })

  it('says when another application holds it', () => {
    expect(hotkeyLabel({ requested: 'F9', status: 'taken' })).toBe('Gyorsbillentyű: F9, FOGLALT, nem működik')
  })

  it('names the invalid value and the default that works in its place', () => {
    expect(
      hotkeyLabel({ requested: 'Spcae', status: 'invalid', fallback: { accelerator: DEFAULT_HOTKEY, status: 'registered' } }),
    ).toBe(`ÉRVÉNYTELEN gyorsbillentyű: Spcae, alapérték él (${DEFAULT_HOTKEY})`)
  })

  it('says when the default could not be registered either', () => {
    expect(
      hotkeyLabel({ requested: 'Spcae', status: 'invalid', fallback: { accelerator: DEFAULT_HOTKEY, status: 'taken' } }),
    ).toBe(`ÉRVÉNYTELEN gyorsbillentyű: Spcae, az alapérték (${DEFAULT_HOTKEY}) is FOGLALT`)
  })

  it('never contains a dash inside the text', () => {
    const cases: HotkeyRegistration[] = [
      { requested: 'F9', status: 'registered' },
      { requested: 'F9', status: 'taken' },
      { requested: 'x', status: 'invalid', fallback: { accelerator: DEFAULT_HOTKEY, status: 'registered' } },
      { requested: 'x', status: 'invalid', fallback: { accelerator: DEFAULT_HOTKEY, status: 'taken' } },
      { requested: 'x', status: 'invalid', fallback: { accelerator: DEFAULT_HOTKEY, status: 'invalid' } },
    ]
    for (const registration of cases) expect(hotkeyLabel(registration)).not.toMatch(/[–—]/)
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
