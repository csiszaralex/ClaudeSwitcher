import { isRecord } from '@claudeswitcher/core'
import { hotkeyRefusal, type HotkeyRegistration } from '../shared/hotkey-status.js'
import {
  isSettingKey,
  parseSettingValues,
  pickSettings,
  settingsToAsk,
  type SettingKey,
  type SettingValues,
} from '../shared/settings.js'
import type { SetupState } from '../shared/setup-state.js'
import type { HotkeySwitch } from './hotkey.js'
import type { SettingsService, SettingsSnapshot } from './settings-service.js'
import type { HookInstallState } from './setup.js'

/**
 * The answer to `setup:load`. The renderer checks it with `readSetupState`, against the same
 * `SetupState` type, so the two sides cannot drift apart. The integration never adds to `ask`:
 * installing it is an action, not a setting.
 */
export function setupState(
  snapshot: SettingsSnapshot,
  extra: { hotkey: HotkeyRegistration; integration: HookInstallState; showAll: boolean },
): SetupState {
  const { values, confirmed, autostartAvailable } = snapshot
  return {
    values,
    ask: settingsToAsk(confirmed, { autostartAvailable }),
    autostartAvailable,
    hotkey: extra.hotkey,
    integration: extra.integration.kind,
    showAll: extra.showAll,
  }
}

/**
 * The setup window's "Mentés": the values it holds and the settings it showed. Only the shown ones
 * are applied and confirmed; a setting the window did not show keeps its value and its confirmation.
 */
export interface SaveRequest {
  values: SettingValues
  shown: SettingKey[]
}

export type SaveResult = { ok: true } | { ok: false; reason: string }

/** IPC input: the renderer may send anything. Repeated keys in `shown` collapse to one. */
export function parseSaveRequest(raw: unknown): SaveRequest | undefined {
  if (!isRecord(raw)) return undefined
  const values = parseSettingValues(raw['values'])
  const { shown } = raw
  if (values === undefined || !Array.isArray(shown) || !shown.every(isSettingKey)) return undefined
  return { values, shown: [...new Set(shown)] }
}

/**
 * Saves the setup window's request. A changed hotkey is switched FIRST, while nothing is applied
 * yet: if the new one does not register, nothing of this save is applied or persisted, and the
 * window stays open with the reason. So a refused hotkey never reaches the config file, and it
 * never counts as confirmed.
 *
 * An unchanged hotkey that does not hold now (taken, or invalid with the default in its place) is
 * left out too: confirming it would stop the window from asking about a hotkey that does not work.
 */
export async function saveSetup(
  request: SaveRequest,
  deps: {
    settings: Pick<SettingsService, 'snapshot' | 'apply'>
    /** The registration that holds now (what `setup:load` reports as `hotkey`). */
    currentHotkey: () => HotkeyRegistration
    /** Moves the global shortcut to `next` (`switchHotkey` with the accelerator the app holds). */
    switchHotkey: (next: string) => HotkeySwitch
  },
): Promise<SaveResult> {
  const { values } = request
  let { shown } = request
  if (shown.includes('hotkey')) {
    if (values.hotkey !== deps.settings.snapshot().values.hotkey) {
      const result = deps.switchHotkey(values.hotkey)
      if (!result.switched) {
        return { ok: false, reason: hotkeyRefusal(values.hotkey, result.attempted, result.registration) }
      }
    } else if (deps.currentHotkey().status !== 'registered') {
      shown = shown.filter((key) => key !== 'hotkey')
    }
  }
  await deps.settings.apply(pickSettings(values, shown), shown)
  return { ok: true }
}
