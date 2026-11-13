import { isInstalledOnly, type SettingKey, type SettingValues } from '../shared/settings.js'
import type { Autostart } from './autostart.js'
import type { StoredConfig, StoredValues } from './config.js'

export interface SettingsSnapshot {
  values: SettingValues
  confirmed: ReadonlySet<SettingKey>
  /** True when running as the installed app (`autostart.available`, which is `app.isPackaged`). */
  installed: boolean
}

/** The running app's settings: the tray and the setup window read and change them only here. */
export interface SettingsService {
  snapshot(): SettingsSnapshot
  /**
   * Applies `patch` in memory (and autostart to the OS) at once, tells every listener, then
   * persists. Resolves with the snapshot after the attempt; a failed write keeps the new values
   * for this run only.
   */
  apply(patch: Partial<SettingValues>, confirm: readonly SettingKey[]): Promise<SettingsSnapshot>
  /**
   * Returns the unsubscribe function. A listener only reflects the change (tray, window); it must
   * not call `apply` itself. A value that needs a check first (the hotkey) is checked before
   * `apply` is called (see `saveSetup`).
   */
  onChange(listener: (snapshot: SettingsSnapshot) => void): () => void
}

export function createSettingsService(deps: {
  stored: StoredConfig
  autostart: Autostart
  persist: (patch: Partial<StoredValues>, confirm: readonly SettingKey[]) => Promise<boolean>
}): SettingsService {
  const { autostart, persist } = deps
  let values: StoredValues = { ...deps.stored.values }
  const confirmed = new Set(deps.stored.confirmed)
  const listeners = new Set<(snapshot: SettingsSnapshot) => void>()
  const notify = (changed: SettingsSnapshot): void => {
    for (const listener of [...listeners]) {
      // One failing listener must not keep the others (the tray, the window) out of date.
      try {
        listener(changed)
      } catch (error) {
        console.error('[settings] a change listener failed', error)
      }
    }
  }

  const snapshot = (): SettingsSnapshot => ({
    values: { ...values, autostart: autostart.enabled() },
    confirmed: new Set(confirmed),
    installed: autostart.available,
  })

  return {
    snapshot,
    async apply(patch, confirm) {
      const { autostart: wanted, ...stored } = patch
      // A repo build shares the config file with the installed app, so it never writes a value
      // that only the installed app uses.
      if (!autostart.available) {
        for (const key of Object.keys(stored)) if (isInstalledOnly(key as SettingKey)) Reflect.deleteProperty(stored, key)
      }
      if (wanted !== undefined && autostart.available) {
        // The snapshot reads the login item back, so a refused write shows as the old state.
        try {
          autostart.set(wanted)
        } catch (error) {
          console.error('[settings] could not change the login item', error)
        }
      }
      // A repo build cannot use the installed-only settings, so answering them there confirms
      // nothing: the installed app still has to ask.
      const accepted = confirm.filter((key) => autostart.available || !isInstalledOnly(key))
      values = { ...values, ...stored }
      for (const key of accepted) confirmed.add(key)
      notify(snapshot())
      if (Object.keys(stored).length > 0 || accepted.length > 0) await persist(stored, accepted)
      return snapshot()
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
