/**
 * The one list of user settings. The config file, the tray and the setup window all read it;
 * a new setting is complete only once it is listed here and shown in the setup window.
 * Compiled by both the main and the renderer projects, so it imports no `node:` module.
 */

import { isRecord } from '@claudeswitcher/core/browser'

/**
 * Az overlay gyorsbillentyűjének alapértéke.
 *
 * Szándékosan NEM `Control+Alt+Space`: azt a Claude desktop alkalmazás foglalja (ezen a
 * gépen lemérve: a regisztráció következetesen elbukott), és Windowson a `Control+Alt`
 * amúgy is azonos az `AltGr`-rel, ami magyar kiosztáson elnyelné az `AltGr+Space`-t: `@`
 * írása közben (`AltGr+V`) egy szóköz felhozná az overlayt. A `Shift+Alt` mindkettőt
 * elkerüli.
 */
export const DEFAULT_HOTKEY = 'Shift+Alt+Space'

export type SettingKey = 'autostart' | 'hideAfterLastDecision' | 'jumpToTab' | 'hotkey'

export interface SettingValues {
  /** Start at login. The OS login item is the source of truth; the config only records the answer. */
  autostart: boolean
  /** Hide the overlay once nobody is waiting after a decision made in the app. */
  hideAfterLastDecision: boolean
  /** Focusing a session also brings up its exact Claude Code tab, not only the window. */
  jumpToTab: boolean
  /** Electron accelerator, e.g. `Shift+Alt+Space`. */
  hotkey: string
}

export type BooleanSettingKey = Exclude<SettingKey, 'hotkey'>

export interface SettingDefinition {
  key: SettingKey
  kind: 'boolean' | 'hotkey'
  label: string
}

/** Window order. */
export const SETTINGS: readonly SettingDefinition[] = [
  { key: 'autostart', kind: 'boolean', label: 'Induljon el bejelentkezéskor' },
  { key: 'hideAfterLastDecision', kind: 'boolean', label: 'Elrejtés az utolsó döntés után' },
  { key: 'jumpToTab', kind: 'boolean', label: 'Ugrás a pontos Claude-tabra' },
  { key: 'hotkey', kind: 'hotkey', label: 'Gyorsbillentyű' },
]

export const DEFAULT_SETTINGS: SettingValues = {
  autostart: true,
  hideAfterLastDecision: true,
  jumpToTab: true,
  hotkey: DEFAULT_HOTKEY,
}

/** Why the autostart row is read-only in a repo build; the tray and the setup window both show it. */
export const AUTOSTART_UNAVAILABLE_NOTE = 'csak a telepített appban'

const KEYS: ReadonlySet<string> = new Set(SETTINGS.map((setting) => setting.key))

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && KEYS.has(value)
}

/** A usable hotkey value: a non-blank string. The config file and the setup window both apply it. */
export function isHotkeyValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Exactly the four setting values: no missing key, no extra key, a non-blank hotkey. */
export function parseSettingValues(raw: unknown): SettingValues | undefined {
  if (!isRecord(raw)) return undefined
  if (Object.keys(raw).length !== SETTINGS.length) return undefined
  const { autostart, hideAfterLastDecision, jumpToTab, hotkey } = raw
  if (typeof autostart !== 'boolean' || typeof hideAfterLastDecision !== 'boolean' || typeof jumpToTab !== 'boolean') {
    return undefined
  }
  if (!isHotkeyValue(hotkey)) return undefined
  return { autostart, hideAfterLastDecision, jumpToTab, hotkey }
}

/** The settings the user has not confirmed yet, in window order. */
export function settingsToAsk(
  confirmed: ReadonlySet<SettingKey>,
  options: { autostartAvailable: boolean },
): SettingKey[] {
  return SETTINGS.map((setting) => setting.key).filter(
    (key) => !confirmed.has(key) && (key !== 'autostart' || options.autostartAvailable),
  )
}

/** The values of `keys` only: what the setup window saves, and the keys it keeps while merging. */
export function pickSettings(values: SettingValues, keys: Iterable<SettingKey>): Partial<SettingValues> {
  const picked: Partial<SettingValues> = {}
  // One case per key: a write through a key union does not type-check, and
  // `switch-exhaustiveness-check` makes a new setting add its case here.
  for (const key of keys) {
    switch (key) {
      case 'autostart':
        picked.autostart = values.autostart
        break
      case 'hideAfterLastDecision':
        picked.hideAfterLastDecision = values.hideAfterLastDecision
        break
      case 'jumpToTab':
        picked.jumpToTab = values.jumpToTab
        break
      case 'hotkey':
        picked.hotkey = values.hotkey
        break
    }
  }
  return picked
}
