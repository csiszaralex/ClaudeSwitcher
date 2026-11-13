import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNotFoundError, isRecord, transformSettingsFile } from '@claudeswitcher/core'
import { DEFAULT_HOTKEY, DEFAULT_SETTINGS, SETTINGS, isHotkeyValue, isSettingKey } from '../shared/settings.js'
import type { SettingKey, SettingValues } from '../shared/settings.js'

export type StoredValues = Omit<SettingValues, 'autostart'>

export interface StoredConfig {
  values: StoredValues
  /** The settings the user has answered. An older file without the list confirms nothing. */
  confirmed: ReadonlySet<SettingKey>
}

const DEFAULT_VALUES: StoredValues = {
  hideAfterLastDecision: DEFAULT_SETTINGS.hideAfterLastDecision,
  jumpToTab: DEFAULT_SETTINGS.jumpToTab,
  checkForUpdates: DEFAULT_SETTINGS.checkForUpdates,
  hotkey: DEFAULT_SETTINGS.hotkey,
}

function defaultConfig(): StoredConfig {
  return { values: { ...DEFAULT_VALUES }, confirmed: new Set() }
}

/** The value of a boolean key, or its default if it is missing or not a boolean. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The known keys of the `confirmed` list; anything else in it, or a non-list, is ignored. */
function confirmedKeys(value: unknown): Set<SettingKey> {
  return new Set(Array.isArray(value) ? value.filter(isSettingKey) : [])
}

/** The path of the config file in Electron's `userData` directory. */
export function configPath(dir: string): string {
  return path.join(dir, 'config.json')
}

/**
 * The raw content of the file, or `undefined` if it does not exist (ENOENT). Every other read error
 * throws: a locked or unreadable file is not "missing", so it must not be overwritten with the
 * defaults either.
 */
async function readRaw(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

/** The file as a JSON object, or `undefined` if it is not one (a broken manual edit). */
function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) return parsed
  } catch {
    // A broken file: the caller decides what happens. It must never be written to.
  }
  return undefined
}

/**
 * Read, modify, write with the core's queued, atomic JSON writer (`transformSettingsFile`): a
 * unique temp name, a rename, a queue per file, and a refusal on a broken, empty or unreadable
 * file. `change` gets the existing object; a missing file arrives as an empty object. Our own
 * config file needs no backup.
 */
async function transformConfig(
  dir: string,
  change: (existing: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await transformSettingsFile(configPath(dir), change, { backup: false })
}

/**
 * The defaults for a missing file. A file containing `{}` arrives as an empty object the same way
 * and means the same (every key at its default), so filling it with the defaults does not change
 * its meaning.
 */
function orDefaults(existing: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(existing).length === 0 ? { ...DEFAULT_VALUES } : existing
}

/**
 * Reads the settings, and never throws.
 *
 * If the file does not exist, it writes it with the defaults, otherwise the user would not know
 * what to edit and where. If the file is broken or unreadable, it returns the defaults but does NOT
 * overwrite it: the manual edit stays, so it can be fixed. An unwritable directory does not stop
 * the startup either.
 *
 * The keys are read one by one: a bad hotkey does not take the good auto-hide or tab-jump value
 * with it, and an older file that does not know a key yet loads with the default for that key,
 * without a rewrite.
 */
export async function loadConfig(dir: string): Promise<StoredConfig> {
  let raw: string | undefined
  try {
    raw = await readRaw(configPath(dir))
  } catch (error) {
    console.error('[claudeswitcher] could not read the config file; using defaults', error)
    return defaultConfig()
  }

  if (raw !== undefined) {
    const parsed = parseObject(raw)
    if (parsed === undefined) return defaultConfig()
    const { hotkey, hideAfterLastDecision, jumpToTab, checkForUpdates, confirmed } = parsed
    return {
      values: {
        hotkey: isHotkeyValue(hotkey) ? hotkey : DEFAULT_HOTKEY,
        hideAfterLastDecision: booleanOr(hideAfterLastDecision, DEFAULT_VALUES.hideAfterLastDecision),
        jumpToTab: booleanOr(jumpToTab, DEFAULT_VALUES.jumpToTab),
        checkForUpdates: booleanOr(checkForUpdates, DEFAULT_VALUES.checkForUpdates),
      },
      confirmed: confirmedKeys(confirmed),
    }
  }

  const config = defaultConfig()
  try {
    // If the file appeared after all since the read, its content stays.
    await transformConfig(dir, orDefaults)
  } catch (error) {
    console.error('[claudeswitcher] could not write the config file; using defaults', error)
  }
  return config
}

/**
 * Persists changed values and, optionally, marks settings as confirmed by the user: the stored
 * list plus `confirm`, deduplicated, in `SETTINGS` order. Never throws; true if it was written.
 *
 * The file is read fresh and only the given keys are rewritten in it: if the user changed the
 * hotkey by hand since the startup (it takes effect after a restart), or added a key of their own,
 * that must not be lost because of a checkbox. A broken or unreadable file is not written to, the
 * same guarantee as on load; the change then lives only in the running app. The calls queue per
 * file, so two changes started one after the other without waiting are both kept.
 */
export async function saveSettings(
  dir: string,
  patch: Partial<StoredValues>,
  confirm: readonly SettingKey[],
): Promise<boolean> {
  try {
    await transformConfig(dir, (existing) => {
      const merged = { ...orDefaults(existing), ...patch }
      const confirmed = confirmedKeys(existing['confirmed'])
      for (const key of confirm) confirmed.add(key)
      const ordered = SETTINGS.map((setting) => setting.key).filter((key) => confirmed.has(key))
      return ordered.length === 0 ? merged : { ...merged, confirmed: ordered }
    })
    return true
  } catch (error) {
    console.error('[claudeswitcher] could not update the config file; not overwriting it', error)
    return false
  }
}
