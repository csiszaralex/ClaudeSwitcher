import { isRecord } from '@claudeswitcher/core/browser'
import type { HotkeyRegistration, HotkeyStatus } from '../shared/hotkey-status.js'
import { isIntegrationKind, type IntegrationKind } from '../shared/integration.js'
import {
  SETTINGS,
  isSettingKey,
  parseSettingValues,
  pickSettings,
  type SettingKey,
  type SettingValues,
} from '../shared/settings.js'
import type { SetupState } from '../shared/setup-state.js'

const HOTKEY_STATUSES: readonly HotkeyStatus[] = ['registered', 'taken', 'invalid']

function readHotkeyStatus(raw: unknown): HotkeyStatus | undefined {
  return HOTKEY_STATUSES.find((status) => status === raw)
}

function readHotkeyRegistration(raw: unknown): HotkeyRegistration | undefined {
  if (!isRecord(raw)) return undefined
  const { requested, fallback } = raw
  const status = readHotkeyStatus(raw['status'])
  if (typeof requested !== 'string' || status === undefined) return undefined
  if (fallback === undefined) return { requested, status }
  if (!isRecord(fallback)) return undefined
  const { accelerator } = fallback
  const fallbackStatus = readHotkeyStatus(fallback['status'])
  if (typeof accelerator !== 'string' || fallbackStatus === undefined) return undefined
  return { requested, status, fallback: { accelerator, status: fallbackStatus } }
}

function readKeys(raw: unknown): SettingKey[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const keys = raw.filter(isSettingKey)
  return keys.length === raw.length ? keys : undefined
}

/** The setup state from IPC, or `undefined` if any part of it is malformed. */
export function readSetupState(raw: unknown): SetupState | undefined {
  if (!isRecord(raw)) return undefined
  const values = parseSettingValues(raw['values'])
  const ask = readKeys(raw['ask'])
  const hotkey = readHotkeyRegistration(raw['hotkey'])
  const { autostartAvailable, integration, showAll } = raw
  if (values === undefined || ask === undefined || hotkey === undefined) return undefined
  if (typeof autostartAvailable !== 'boolean' || typeof showAll !== 'boolean' || !isIntegrationKind(integration)) {
    return undefined
  }
  return { values, ask, autostartAvailable, hotkey, integration, showAll }
}

/**
 * The settings the window shows, in window order: only the unconfirmed ones on a first-run open,
 * all of them with `showAll` (the tray, or the "Minden beállítás" link) or when nothing is left to ask.
 */
export function visibleSettings(state: SetupState, showAll: boolean): SettingKey[] {
  const all = SETTINGS.map((setting) => setting.key)
  if (showAll || state.ask.length === 0) return all
  return all.filter((key) => state.ask.includes(key))
}

/**
 * The values after a change from outside the window (the tray): what the user changed in the
 * window stays, everything else follows the app.
 */
export function mergeExternal(
  edited: SettingValues,
  dirty: ReadonlySet<SettingKey>,
  incoming: SettingValues,
): SettingValues {
  return { ...incoming, ...pickSettings(edited, dirty) }
}

/** The answer to `setup:save` (the main process's `SaveResult`); anything malformed is a failure. */
export function readSaveReply(raw: unknown): { ok: true } | { ok: false; reason: string } {
  if (isRecord(raw) && raw['ok'] === true) return { ok: true }
  if (isRecord(raw) && raw['ok'] === false && typeof raw['reason'] === 'string') return { ok: false, reason: raw['reason'] }
  return { ok: false, reason: MALFORMED_REPLY }
}

/** The answer to `setup:install`; anything malformed is a failure. */
export function readInstallReply(raw: unknown): { ok: boolean; message: string } {
  if (isRecord(raw) && typeof raw['ok'] === 'boolean' && typeof raw['message'] === 'string') {
    return { ok: raw['ok'], message: raw['message'] }
  }
  return { ok: false, message: MALFORMED_REPLY }
}

const MALFORMED_REPLY = 'A ClaudeSwitcher érvénytelen választ adott.'

/** The integration row's text. A missing integration never adds to `ask`: it is an action. */
export function integrationLabel(kind: IntegrationKind): string {
  switch (kind) {
    case 'current':
      return 'Telepítve'
    case 'stale':
      return 'Elavult, telepítsd újra'
    case 'not-installed':
      return 'Nincs telepítve'
    case 'unknown':
      return 'Ismeretlen, a settings.json nem olvasható'
  }
}

export type IntegrationAction = 'install' | 'uninstall'

/**
 * The integration buttons for a state. An unreadable settings.json (`unknown`) offers both: the
 * attempt then shows what is wrong.
 */
export function integrationActions(kind: IntegrationKind): IntegrationAction[] {
  switch (kind) {
    case 'not-installed':
      return ['install']
    case 'current':
      return ['uninstall']
    case 'stale':
    case 'unknown':
      return ['install', 'uninstall']
  }
}

/** The `setup:captured` payload: the captured accelerator, or `undefined` for a cancelled capture. */
export function readCaptured(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const { accelerator } = raw
  return typeof accelerator === 'string' && accelerator !== '' ? accelerator : undefined
}
