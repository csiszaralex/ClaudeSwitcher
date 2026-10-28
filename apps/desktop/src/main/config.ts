import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNotFoundError, isRecord, transformSettingsFile } from '@claudeswitcher/core'

/**
 * Az overlay gyorsbillentyűjének alapértéke.
 *
 * Szándékosan NEM `Control+Alt+Space`: azt a Claude desktop alkalmazás foglalja (ezen a
 * gépen lemérve — a regisztráció következetesen elbukott), és Windowson a `Control+Alt`
 * amúgy is azonos az `AltGr`-rel, ami magyar kiosztáson elnyelné az `AltGr+Space`-t — `@`
 * írása közben (`AltGr+V`) egy szóköz felhozná az overlayt. A `Shift+Alt` mindkettőt
 * elkerüli.
 */
export const DEFAULT_HOTKEY = 'Shift+Alt+Space'

export interface Config {
  /** Electron accelerator, pl. `Shift+Alt+Space`. */
  hotkey: string
  /**
   * Elrejtőzzön-e az overlay, ha az appból eldöntött kérés után már senki nem vár. Alapból igen
   * (az eredeti kérés), de kikapcsolható: „néha jól jön, hogy ott van és csak A-kat kell nyomni".
   */
  hideAfterLastDecision: boolean
  /**
   * A fókuszálás a session pontos Claude Code tabját is előhozza-e, nem csak az ablakát. Alapból
   * igen; kikapcsolva a viselkedés pontosan az M1-es: csak az ablak jön elő.
   */
  jumpToTab: boolean
}

const DEFAULT_CONFIG: Config = { hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: true, jumpToTab: true }

/** Egy logikai kulcs értéke, vagy az alapértéke, ha hiányzik vagy nem logikai érték. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
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

/** A fájl JSON-objektumként, vagy `undefined`, ha nem az — elrontott kézi szerkesztés. */
function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) return parsed
  } catch {
    // Elrontott fájl: a hívó dönti el, mi legyen — írni sosem szabad bele.
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
  return Object.keys(existing).length === 0 ? { ...DEFAULT_CONFIG } : existing
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
 * alapértékkel töltődik be — átírás nélkül.
 */
export async function loadConfig(dir: string): Promise<Config> {
  let raw: string | undefined
  try {
    raw = await readRaw(configPath(dir))
  } catch (error) {
    console.error('[claudeswitcher] could not read the config file; using defaults', error)
    return { ...DEFAULT_CONFIG }
  }

  if (raw !== undefined) {
    const parsed = parseObject(raw)
    if (parsed === undefined) return { ...DEFAULT_CONFIG }
    const { hotkey, hideAfterLastDecision, jumpToTab } = parsed
    return {
      hotkey: typeof hotkey === 'string' && hotkey.trim() !== '' ? hotkey : DEFAULT_HOTKEY,
      hideAfterLastDecision: booleanOr(hideAfterLastDecision, DEFAULT_CONFIG.hideAfterLastDecision),
      jumpToTab: booleanOr(jumpToTab, DEFAULT_CONFIG.jumpToTab),
    }
  }

  const config: Config = { ...DEFAULT_CONFIG }
  try {
    // Ha a fájl az olvasás óta mégis megjelent, a tartalma marad.
    await transformConfig(dir, orDefaults)
  } catch (error) {
    console.error('[claudeswitcher] could not write the config file; using defaults', error)
  }
  return config
}

/**
 * Egy beállítás tartós módosítása (a tálcamenüből). Soha nem dob; igaz, ha sikerült kiírni.
 *
 * A fájlt frissen olvassuk be, és csak a megadott kulcsokat írjuk át benne: ha a felhasználó
 * indulás óta kézzel átírta a gyorsbillentyűt (az újraindítás után él), vagy saját kulcsot
 * tett bele, az nem veszhet el egy pipa miatt. Elrontott vagy olvashatatlan fájlba nem írunk,
 * ugyanaz a garancia, mint a betöltésnél; a változás ilyenkor csak a futó appban él. A hívások
 * fájlonként sorba állnak, így két egymás után, várakozás nélkül indított módosítás is megmarad.
 */
export async function updateConfig(dir: string, patch: Partial<Config>): Promise<boolean> {
  try {
    await transformConfig(dir, (existing) => ({ ...orDefaults(existing), ...patch }))
    return true
  } catch (error) {
    console.error('[claudeswitcher] could not update the config file; not overwriting it', error)
    return false
  }
}
