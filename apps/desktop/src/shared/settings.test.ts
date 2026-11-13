import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY, DEFAULT_SETTINGS, SETTINGS, isInstalledOnly, isSettingKey, parseSettingValues, pickSettings, settingsToAsk } from './settings.js'
import type { BooleanSettingKey, SettingKey, SettingValues } from './settings.js'

describe('SETTINGS', () => {
  it('lists the settings in window order with the tray labels', () => {
    expect(SETTINGS.map((setting) => setting.key)).toEqual(['autostart', 'hideAfterLastDecision', 'jumpToTab', 'checkForUpdates', 'hotkey'])
    expect(SETTINGS.map((setting) => setting.label)).toEqual([
      'Induljon el bejelentkezéskor',
      'Elrejtés az utolsó döntés után',
      'Ugrás a pontos Claude-tabra',
      'Frissítések keresése',
      'Gyorsbillentyű',
    ])
  })

  it('has a default for every listed setting', () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(SETTINGS.map((setting) => setting.key).sort())
    expect(DEFAULT_SETTINGS.hotkey).toBe(DEFAULT_HOTKEY)
  })
})

describe('boolean settings', () => {
  it('are exactly the ones whose default is a boolean', () => {
    const flags: BooleanSettingKey[] = ['autostart', 'hideAfterLastDecision', 'jumpToTab', 'checkForUpdates']
    expect(SETTINGS.filter((setting) => setting.kind === 'boolean').map((setting) => setting.key)).toEqual(flags)
    for (const key of flags) expect(typeof DEFAULT_SETTINGS[key]).toBe('boolean')
  })
})

describe('isSettingKey', () => {
  it('accepts the listed keys only', () => {
    expect(isSettingKey('jumpToTab')).toBe(true)
    expect(isSettingKey('bogus')).toBe(false)
    expect(isSettingKey(3)).toBe(false)
    expect(isSettingKey(undefined)).toBe(false)
  })
})

describe('settingsToAsk', () => {
  it('asks everything on a first start', () => {
    expect(settingsToAsk(new Set(), { installed: true })).toEqual([
      'autostart',
      'hideAfterLastDecision',
      'jumpToTab',
      'checkForUpdates',
      'hotkey',
    ])
  })

  it('asks only the new setting after an update', () => {
    const confirmed = new Set<SettingKey>(['hideAfterLastDecision', 'jumpToTab', 'checkForUpdates', 'hotkey'])
    expect(settingsToAsk(confirmed, { installed: true })).toEqual(['autostart'])
  })

  it('never asks autostart where it cannot be set', () => {
    expect(settingsToAsk(new Set(), { installed: false })).not.toContain('autostart')
    const rest = new Set<SettingKey>(['hideAfterLastDecision', 'jumpToTab', 'checkForUpdates', 'hotkey'])
    expect(settingsToAsk(rest, { installed: false })).toEqual([])
  })

  it('skips checkForUpdates in a repo build and asks it in the installed app', () => {
    const rest = new Set<SettingKey>(['autostart', 'hideAfterLastDecision', 'jumpToTab', 'hotkey'])
    expect(settingsToAsk(rest, { installed: false })).toEqual([])
    expect(settingsToAsk(rest, { installed: true })).toEqual(['checkForUpdates'])
    expect(settingsToAsk(new Set(), { installed: false })).toEqual(['hideAfterLastDecision', 'jumpToTab', 'hotkey'])
  })
})

describe('isInstalledOnly', () => {
  it('is true for exactly autostart and checkForUpdates', () => {
    expect(SETTINGS.map((setting) => setting.key).filter(isInstalledOnly)).toEqual(['autostart', 'checkForUpdates'])
  })
})

describe('parseSettingValues', () => {
  it('accepts the defaults', () => {
    expect(parseSettingValues(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects a missing key', () => {
    const rest: Partial<SettingValues> = { ...DEFAULT_SETTINGS }
    delete rest.jumpToTab
    expect(parseSettingValues(rest)).toBeUndefined()
    const withoutUpdates: Partial<SettingValues> = { ...DEFAULT_SETTINGS }
    delete withoutUpdates.checkForUpdates
    expect(parseSettingValues(withoutUpdates)).toBeUndefined()
  })

  it('rejects a non-boolean flag', () => {
    expect(parseSettingValues({ ...DEFAULT_SETTINGS, autostart: 'true' })).toBeUndefined()
    expect(parseSettingValues({ ...DEFAULT_SETTINGS, checkForUpdates: 1 })).toBeUndefined()
  })

  it('rejects a blank or non-string hotkey', () => {
    expect(parseSettingValues({ ...DEFAULT_SETTINGS, hotkey: '   ' })).toBeUndefined()
    expect(parseSettingValues({ ...DEFAULT_SETTINGS, hotkey: 7 })).toBeUndefined()
  })

  it('rejects extra keys and inputs that are not objects', () => {
    expect(parseSettingValues({ ...DEFAULT_SETTINGS, extra: 1 })).toBeUndefined()
    for (const bad of [null, undefined, 'x', 3, [], true]) expect(parseSettingValues(bad)).toBeUndefined()
  })
})

describe('pickSettings', () => {
  it('copies exactly the given keys', () => {
    const values: SettingValues = { ...DEFAULT_SETTINGS, jumpToTab: false, hotkey: 'F9' }
    expect(pickSettings(values, ['jumpToTab', 'hotkey'])).toEqual({ jumpToTab: false, hotkey: 'F9' })
    expect(pickSettings(values, [])).toEqual({})
    expect(pickSettings({ ...values, checkForUpdates: false }, ['checkForUpdates'])).toEqual({ checkForUpdates: false })
  })
})
