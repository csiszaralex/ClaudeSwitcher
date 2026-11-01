import { describe, expect, it } from 'vitest'
import { hotkeyLabel, hotkeyRefusal, type HotkeyRegistration } from './hotkey-status.js'
import { DEFAULT_HOTKEY } from './settings.js'

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

describe('hotkeyRefusal', () => {
  it('says the new hotkey is taken and the old one still holds', () => {
    expect(hotkeyRefusal('F9', 'taken', { requested: 'F8', status: 'registered' })).toBe(
      'Ez a gyorsbillentyű foglalt, egy másik alkalmazás használja: F9. Marad a régi: F8.',
    )
  })

  it('says the new hotkey is invalid', () => {
    expect(hotkeyRefusal('Spcae', 'invalid', { requested: 'F8', status: 'registered' })).toBe(
      'Ez nem érvényes gyorsbillentyű: Spcae. Marad a régi: F8.',
    )
  })

  it('says when the old hotkey could not be taken back either', () => {
    expect(hotkeyRefusal('F9', 'taken', { requested: 'F8', status: 'taken' })).toBe(
      'Ez a gyorsbillentyű foglalt, egy másik alkalmazás használja: F9. A régit (F8) sem sikerült visszavenni, most nincs működő gyorsbillentyű.',
    )
  })

  it('never contains a dash inside the text', () => {
    for (const attempted of ['taken', 'invalid'] as const) {
      for (const status of ['registered', 'taken', 'invalid'] as const) {
        expect(hotkeyRefusal('F9', attempted, { requested: 'F8', status })).not.toMatch(/[–—]/)
      }
    }
  })
})
