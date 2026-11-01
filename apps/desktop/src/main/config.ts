import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNotFoundError, isRecord, transformSettingsFile } from '@claudeswitcher/core'
import { DEFAULT_HOTKEY, DEFAULT_SETTINGS, SETTINGS, isSettingKey } from '../shared/settings.js'
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
  hotkey: DEFAULT_SETTINGS.hotkey,
}

function defaultConfig(): StoredConfig {
  return { values: { ...DEFAULT_VALUES }, confirmed: new Set() }
}

/** Egy logikai kulcs értéke, vagy az alapértéke, ha hiányzik vagy nem logikai érték. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The known keys of the `confirmed` list; anything else in it, or a non-list, is ignored. */
function confirmedKeys(value: unknown): Set<SettingKey> {
  return new Set(Array.isArray(value) ? value.filter(isSettingKey) : [])
}

/** A config fájl útvonala az Electron `userData` könyvtárában. */
export function configPath(dir: string): string {
  return path.join(dir, 'config.json')
}

/**
 * A fájl nyers tartalma, vagy `undefined`, ha nincs meg (ENOENT). Minden más olvasási hiba dob:
 * egy foglalt vagy olvashatatlan fájl nem „hiányzik", tehát az alapértékekkel sem írhatjuk felül.
 */
async function readRaw(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

/** A fájl JSON-objektumként, vagy `undefined`, ha nem az (elrontott kézi szerkesztés). */
function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) return parsed
  } catch {
    // Elrontott fájl: a hívó dönti el, mi legyen. Írni sosem szabad bele.
  }
  return undefined
}

/**
 * Olvasás, módosítás, írás a core sorba állított, atomikus JSON-írójával (`transformSettingsFile`):
 * egyedi temp név, átnevezés, fájlonkénti sor, és elutasítás elrontott, üres vagy olvashatatlan
 * fájlnál. A `change` a meglévő objektumot kapja; egy hiányzó fájl üres objektumként érkezik.
 * Biztonsági másolat a saját config fájlunkhoz nem kell.
 */
async function transformConfig(
  dir: string,
  change: (existing: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await transformSettingsFile(configPath(dir), change, { backup: false })
}

/**
 * Hiányzó fájlnál az alapértékek. Egy `{}` tartalmú fájl ugyanígy üres objektumként érkezik, és
 * ugyanazt jelenti (minden kulcs az alapértékén), tehát az alapértékekkel feltölteni nem változtat
 * a jelentésén.
 */
function orDefaults(existing: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(existing).length === 0 ? { ...DEFAULT_VALUES } : existing
}

/**
 * Beolvassa a beállításokat, és soha nem dob.
 *
 * Ha a fájl nincs meg, kiírja az alapértékekkel, különben a felhasználó nem tudná, mit és
 * hol szerkeszthet. Ha a fájl elromlott vagy nem olvasható, az alapértékeket adja, de NEM írja
 * felül: a kézi szerkesztés maradjon meg, hogy ki lehessen javítani. Egy írhatatlan könyvtár sem
 * akadályozza meg az indulást.
 *
 * A kulcsokat egyenként olvassuk: egy hibás gyorsbillentyű nem viszi el a jó auto-hide vagy
 * tab-ugrás értéket, és egy régebbi, egy kulcsot még nem ismerő fájl arra a kulcsra az
 * alapértékkel töltődik be, átírás nélkül.
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
    const { hotkey, hideAfterLastDecision, jumpToTab, confirmed } = parsed
    return {
      values: {
        hotkey: typeof hotkey === 'string' && hotkey.trim() !== '' ? hotkey : DEFAULT_HOTKEY,
        hideAfterLastDecision: booleanOr(hideAfterLastDecision, DEFAULT_VALUES.hideAfterLastDecision),
        jumpToTab: booleanOr(jumpToTab, DEFAULT_VALUES.jumpToTab),
      },
      confirmed: confirmedKeys(confirmed),
    }
  }

  const config = defaultConfig()
  try {
    // Ha a fájl az olvasás óta mégis megjelent, a tartalma marad.
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
 * A fájlt frissen olvassuk be, és csak a megadott kulcsokat írjuk át benne: ha a felhasználó
 * indulás óta kézzel átírta a gyorsbillentyűt (az újraindítás után él), vagy saját kulcsot
 * tett bele, az nem veszhet el egy pipa miatt. Elrontott vagy olvashatatlan fájlba nem írunk,
 * ugyanaz a garancia, mint a betöltésnél; a változás ilyenkor csak a futó appban él. A hívások
 * fájlonként sorba állnak, így két egymás után, várakozás nélkül indított módosítás is megmarad.
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
