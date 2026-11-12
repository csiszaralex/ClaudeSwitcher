import { describe, expect, it } from 'vitest'
import { INTEGRATION_KINDS } from '../shared/integration.js'
import { SETTINGS, type SettingKey, type SettingValues } from '../shared/settings.js'
import {
  integrationActions,
  integrationLabel,
  readCaptured,
  mergeExternal,
  readInstallReply,
  readSaveReply,
  readSetupState,
  visibleSettings,
} from './setup-view.js'
import type { SetupState } from '../shared/setup-state.js'

const VALUES: SettingValues = { autostart: true, hideAfterLastDecision: true, jumpToTab: true, checkForUpdates: true, hotkey: 'Shift+Alt+Space' }

function state(overrides: Partial<SetupState> = {}): SetupState {
  return {
    values: VALUES,
    ask: ['hotkey'],
    autostartAvailable: true,
    hotkey: { requested: 'Shift+Alt+Space', status: 'registered' },
    integration: 'current',
    showAll: false,
    ...overrides,
  }
}

const ALL_KEYS = SETTINGS.map((setting) => setting.key)

describe('visibleSettings', () => {
  it('shows only the unconfirmed settings on a first-run open', () => {
    expect(visibleSettings(state({ ask: ['jumpToTab', 'hotkey'] }), false)).toEqual(['jumpToTab', 'hotkey'])
  })

  it('shows every setting with showAll, in window order', () => {
    expect(visibleSettings(state({ ask: ['hotkey'] }), true)).toEqual(ALL_KEYS)
  })

  it('shows every setting when nothing is left to ask', () => {
    expect(visibleSettings(state({ ask: [] }), false)).toEqual(ALL_KEYS)
  })
})

describe('mergeExternal', () => {
  it('keeps the keys the user edited and takes the rest from the incoming values', () => {
    const edited: SettingValues = { ...VALUES, jumpToTab: false, hotkey: 'F9' }
    const incoming: SettingValues = { ...VALUES, jumpToTab: true, hideAfterLastDecision: false, hotkey: 'F8' }
    const dirty: ReadonlySet<SettingKey> = new Set(['hotkey'])
    expect(mergeExternal(edited, dirty, incoming)).toEqual({
      autostart: true,
      hideAfterLastDecision: false,
      jumpToTab: true,
      checkForUpdates: true,
      hotkey: 'F9',
    })
  })

  it('takes everything from the incoming values when nothing was edited', () => {
    const incoming: SettingValues = { ...VALUES, autostart: false }
    expect(mergeExternal({ ...VALUES, jumpToTab: false }, new Set(), incoming)).toEqual(incoming)
  })
})

describe('readSetupState', () => {
  it('accepts a valid state', () => {
    const valid = state({
      hotkey: { requested: 'Spcae', status: 'invalid', fallback: { accelerator: 'Shift+Alt+Space', status: 'registered' } },
      integration: 'stale',
      showAll: true,
    })
    expect(readSetupState(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })

  it('rejects a payload missing values', () => {
    const rest: Record<string, unknown> = { ...state() }
    delete rest['values']
    expect(readSetupState(rest)).toBeUndefined()
  })

  it('rejects invalid values, an unknown asked key and an unknown integration kind', () => {
    expect(readSetupState({ ...state(), values: { ...VALUES, extra: true } })).toBeUndefined()
    expect(readSetupState({ ...state(), ask: ['hotkey', 'theme'] })).toBeUndefined()
    expect(readSetupState({ ...state(), integration: 'broken' })).toBeUndefined()
  })

  it('rejects a malformed hotkey registration and missing flags', () => {
    expect(readSetupState({ ...state(), hotkey: { requested: 'F9', status: 'busy' } })).toBeUndefined()
    expect(readSetupState({ ...state(), hotkey: { status: 'registered' } })).toBeUndefined()
    expect(
      readSetupState({ ...state(), hotkey: { requested: 'F9', status: 'invalid', fallback: { accelerator: 'F8' } } }),
    ).toBeUndefined()
    expect(readSetupState({ ...state(), showAll: 'yes' })).toBeUndefined()
    expect(readSetupState({ ...state(), autostartAvailable: undefined })).toBeUndefined()
    expect(readSetupState(null)).toBeUndefined()
    expect(readSetupState([])).toBeUndefined()
  })
})

describe('readSaveReply', () => {
  it('reads success and a refusal with its reason', () => {
    expect(readSaveReply({ ok: true })).toEqual({ ok: true })
    expect(readSaveReply({ ok: false, reason: 'Foglalt.' })).toEqual({ ok: false, reason: 'Foglalt.' })
  })

  it('turns a malformed reply into a failure', () => {
    expect(readSaveReply(undefined)).toMatchObject({ ok: false })
    expect(readSaveReply({ ok: false })).toMatchObject({ ok: false })
    expect(readSaveReply({ ok: 'true' })).toMatchObject({ ok: false })
  })
})

describe('readInstallReply', () => {
  it('reads the result and its message', () => {
    expect(readInstallReply({ ok: true, message: 'Kész.' })).toEqual({ ok: true, message: 'Kész.' })
  })

  it('turns a malformed reply into a failure', () => {
    expect(readInstallReply({ ok: true })).toMatchObject({ ok: false })
    expect(readInstallReply(null)).toMatchObject({ ok: false })
  })
})

describe('integrationLabel', () => {
  it('names every state without a dash inside the text', () => {
    expect(integrationLabel('current')).toBe('Telepítve')
    expect(integrationLabel('stale')).toBe('Elavult, telepítsd újra')
    expect(integrationLabel('not-installed')).toBe('Nincs telepítve')
    for (const kind of INTEGRATION_KINDS) expect(integrationLabel(kind)).not.toMatch(/[–—]/)
  })
})

describe('integrationActions', () => {
  it('offers install when missing, removal when current, both when stale or unknown', () => {
    expect(integrationActions('not-installed')).toEqual(['install'])
    expect(integrationActions('current')).toEqual(['uninstall'])
    expect(integrationActions('stale')).toEqual(['install', 'uninstall'])
    expect(integrationActions('unknown')).toEqual(['install', 'uninstall'])
  })
})

describe('readCaptured', () => {
  it('reads a captured accelerator and treats anything else as a cancel', () => {
    expect(readCaptured({ accelerator: 'Shift+Alt+Space' })).toBe('Shift+Alt+Space')
    expect(readCaptured({ cancelled: true })).toBeUndefined()
    expect(readCaptured({ accelerator: '' })).toBeUndefined()
    expect(readCaptured(null)).toBeUndefined()
  })
})
