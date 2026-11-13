import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type SettingKey, type SettingValues } from '../shared/settings.js'
import type { HotkeyRegistration } from '../shared/hotkey-status.js'
import type { HotkeySwitch } from './hotkey.js'
import type { SettingsSnapshot } from './settings-service.js'
import { parseSaveRequest, saveSetup, setupState, type SaveRequest } from './setup-ipc.js'

const VALUES: SettingValues = { autostart: true, hideAfterLastDecision: true, jumpToTab: true, checkForUpdates: true, hotkey: 'Shift+Alt+Space' }

describe('parseSaveRequest', () => {
  it('accepts a valid request', () => {
    const request: SaveRequest = { values: { ...VALUES, jumpToTab: false }, shown: ['jumpToTab', 'hotkey'] }
    expect(parseSaveRequest(JSON.parse(JSON.stringify(request)))).toEqual(request)
  })

  it('drops repeated keys from shown', () => {
    expect(parseSaveRequest({ values: VALUES, shown: ['hotkey', 'hotkey'] })?.shown).toEqual(['hotkey'])
  })

  it('rejects an unknown key in shown', () => {
    expect(parseSaveRequest({ values: VALUES, shown: ['hotkey', 'theme'] })).toBeUndefined()
    expect(parseSaveRequest({ values: VALUES, shown: [1] })).toBeUndefined()
  })

  it('rejects invalid values', () => {
    expect(parseSaveRequest({ values: { ...VALUES, hotkey: ' ' }, shown: [] })).toBeUndefined()
    expect(parseSaveRequest({ values: { ...VALUES, jumpToTab: 'yes' }, shown: [] })).toBeUndefined()
    expect(parseSaveRequest({ shown: [] })).toBeUndefined()
  })

  it('rejects a non-array shown and a non-object request', () => {
    expect(parseSaveRequest({ values: VALUES, shown: 'hotkey' })).toBeUndefined()
    expect(parseSaveRequest({ values: VALUES })).toBeUndefined()
    expect(parseSaveRequest(null)).toBeUndefined()
    expect(parseSaveRequest([VALUES])).toBeUndefined()
  })
})

interface ApplyCall {
  patch: Partial<SettingValues>
  confirm: readonly SettingKey[]
}

/** Records every `apply`; `switchHotkey` answers with `outcome` and records what it was asked. */
function fakes(
  outcome: HotkeySwitch,
  current: HotkeyRegistration = { requested: 'Shift+Alt+Space', status: 'registered' },
): {
  deps: Parameters<typeof saveSetup>[1]
  applied: ApplyCall[]
  switched: string[]
} {
  const applied: ApplyCall[] = []
  const switched: string[] = []
  const snapshot: SettingsSnapshot = { values: VALUES, confirmed: new Set(), autostartAvailable: true }
  return {
    deps: {
      settings: {
        snapshot: () => snapshot,
        apply: (patch, confirm) => {
          applied.push({ patch, confirm })
          return Promise.resolve(snapshot)
        },
      },
      currentHotkey: () => current,
      switchHotkey: (next) => {
        switched.push(next)
        return outcome
      },
    },
    applied,
    switched,
  }
}

const SWITCHED: HotkeySwitch = { switched: true, registration: { requested: 'F9', status: 'registered' } }

describe('saveSetup', () => {
  it('applies and confirms only the shown settings', async () => {
    const { deps, applied, switched } = fakes(SWITCHED)
    const result = await saveSetup({ values: { ...VALUES, jumpToTab: false, autostart: false }, shown: ['jumpToTab'] }, deps)
    expect(result).toEqual({ ok: true })
    expect(applied).toEqual([{ patch: { jumpToTab: false }, confirm: ['jumpToTab'] }])
    expect(switched).toEqual([])
  })

  it('confirms an unchanged hotkey without switching it', async () => {
    const { deps, applied, switched } = fakes(SWITCHED)
    await saveSetup({ values: VALUES, shown: ['hotkey'] }, deps)
    expect(switched).toEqual([])
    expect(applied).toEqual([{ patch: { hotkey: 'Shift+Alt+Space' }, confirm: ['hotkey'] }])
  })

  it('switches a changed hotkey first, then applies and confirms it', async () => {
    const { deps, applied, switched } = fakes(SWITCHED)
    const result = await saveSetup({ values: { ...VALUES, hotkey: 'F9' }, shown: ['jumpToTab', 'hotkey'] }, deps)
    expect(result).toEqual({ ok: true })
    expect(switched).toEqual(['F9'])
    expect(applied).toEqual([{ patch: { jumpToTab: true, hotkey: 'F9' }, confirm: ['jumpToTab', 'hotkey'] }])
  })

  it('applies nothing at all when the new hotkey is refused, and says why', async () => {
    const { deps, applied } = fakes({
      switched: false,
      attempted: 'taken',
      registration: { requested: 'Shift+Alt+Space', status: 'registered' },
    })
    const result = await saveSetup({ values: { ...VALUES, hotkey: 'F9', jumpToTab: false }, shown: ['jumpToTab', 'hotkey'] }, deps)
    expect(applied).toEqual([])
    expect(result).toEqual({
      ok: false,
      reason: 'Ez a gyorsbillentyű foglalt, egy másik alkalmazás használja: F9. Marad a régi: Shift+Alt+Space.',
    })
  })

  it('does not confirm an unchanged hotkey that does not hold, so the window keeps asking', async () => {
    for (const current of [
      { requested: 'Shift+Alt+Space', status: 'taken' },
      { requested: 'Shift+Alt+Space', status: 'invalid', fallback: { accelerator: 'Shift+Alt+Space', status: 'registered' } },
    ] satisfies HotkeyRegistration[]) {
      const { deps, applied, switched } = fakes(SWITCHED, current)
      const result = await saveSetup({ values: { ...VALUES, jumpToTab: false }, shown: ['jumpToTab', 'hotkey'] }, deps)
      expect(result).toEqual({ ok: true })
      expect(switched).toEqual([])
      expect(applied).toEqual([{ patch: { jumpToTab: false }, confirm: ['jumpToTab'] }])
    }
  })

  it('does not switch a hotkey the window did not show', async () => {
    const { deps, applied, switched } = fakes(SWITCHED)
    await saveSetup({ values: { ...VALUES, hotkey: 'F9' }, shown: ['autostart'] }, deps)
    expect(switched).toEqual([])
    expect(applied).toEqual([{ patch: { autostart: true }, confirm: ['autostart'] }])
  })
})

describe('setupState', () => {
  const hotkey = { requested: 'Shift+Alt+Space', status: 'registered' } as const

  it('asks for the unconfirmed settings and passes the rest through', () => {
    const snapshot: SettingsSnapshot = { values: VALUES, confirmed: new Set(['jumpToTab']), autostartAvailable: true }
    expect(setupState(snapshot, { hotkey, integration: { kind: 'stale', missing: ['Stop'], tokenMismatch: false }, showAll: true })).toEqual({
      values: VALUES,
      ask: ['autostart', 'hideAfterLastDecision', 'checkForUpdates', 'hotkey'],
      autostartAvailable: true,
      hotkey,
      integration: 'stale',
      showAll: true,
    })
  })

  it('pre-ticks the default autostart while it is unconfirmed, whatever the OS says', () => {
    const snapshot: SettingsSnapshot = {
      values: { ...VALUES, autostart: false },
      confirmed: new Set(['jumpToTab']),
      autostartAvailable: true,
    }
    const state = setupState(snapshot, { hotkey, integration: { kind: 'not-installed' }, showAll: false })
    expect(state.values.autostart).toBe(DEFAULT_SETTINGS.autostart)
    expect(state.values.autostart).toBe(true)
  })

  it('shows the real OS autostart once it is confirmed', () => {
    const snapshot: SettingsSnapshot = {
      values: { ...VALUES, autostart: false },
      confirmed: new Set(['autostart']),
      autostartAvailable: true,
    }
    const state = setupState(snapshot, { hotkey, integration: { kind: 'not-installed' }, showAll: true })
    expect(state.values.autostart).toBe(false)
  })

  it('shows the snapshot value where autostart is unavailable', () => {
    const snapshot: SettingsSnapshot = {
      values: { ...VALUES, autostart: false },
      confirmed: new Set(),
      autostartAvailable: false,
    }
    const state = setupState(snapshot, { hotkey, integration: { kind: 'not-installed' }, showAll: true })
    expect(state.values.autostart).toBe(false)
  })

  it('never asks for autostart where it is unavailable, and never for the integration', () => {
    const snapshot: SettingsSnapshot = {
      values: VALUES,
      confirmed: new Set(['hideAfterLastDecision', 'jumpToTab', 'checkForUpdates', 'hotkey']),
      autostartAvailable: false,
    }
    const state = setupState(snapshot, { hotkey, integration: { kind: 'not-installed' }, showAll: false })
    expect(state.ask).toEqual([])
    expect(state.integration).toBe('not-installed')
  })
})
