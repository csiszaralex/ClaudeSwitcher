import type { HotkeyRegistration } from './hotkey-status.js'
import type { IntegrationKind } from './integration.js'
import type { SettingKey, SettingValues } from './settings.js'

/**
 * What the setup window shows: the main process builds it for `setup:load` (`setupState` in
 * `main/setup-ipc.ts`), the renderer checks it (`readSetupState`). Here, because both projects
 * compile `src/shared`, so the two sides share one type.
 */
export interface SetupState {
  values: SettingValues
  /** The settings the user has never confirmed (`settingsToAsk`), in window order. */
  ask: SettingKey[]
  /** True when running as the installed app; the installed-only settings are read-only otherwise. */
  installed: boolean
  /** The hotkey registration that holds now. */
  hotkey: HotkeyRegistration
  integration: IntegrationKind
  /** True when the tray opened the window ("Beállítások"), false for the first-run open. */
  showAll: boolean
}
