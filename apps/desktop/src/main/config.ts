import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

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
}

const DEFAULT_CONFIG: Config = { hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: true }

/** A config fájl útvonala az Electron `userData` könyvtárában. */
export function configPath(dir: string): string {
  return path.join(dir, 'config.json')
}

/** A fájl nyers tartalma, vagy `undefined`, ha nem olvasható (tipikusan: nincs meg). */
async function readRaw(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** A fájl JSON-objektumként, vagy `undefined`, ha nem az — elrontott kézi szerkesztés. */
function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Elrontott fájl: a hívó dönti el, mi legyen — írni sosem szabad bele.
  }
  return undefined
}

/**
 * Atomikus írás: ideiglenes fájl, majd átnevezés. Egy félbeszakadt írás így nem hagy
 * félkész configot, amit a következő indulás már elrontottnak látna.
 */
async function writeObject(dir: string, value: Record<string, unknown>): Promise<void> {
  const file = configPath(dir)
  await mkdir(dir, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Beolvassa a beállításokat, és soha nem dob.
 *
 * Ha a fájl nincs meg, kiírja az alapértékekkel — különben a felhasználó nem tudná, mit és
 * hol szerkeszthet. Ha a fájl elromlott, az alapértékeket adja, de NEM írja felül: a kézi
 * szerkesztés maradjon meg, hogy ki lehessen javítani. Egy írhatatlan könyvtár sem
 * akadályozza meg az indulást.
 *
 * A kulcsokat egyenként olvassuk: egy hibás gyorsbillentyű nem viszi el a jó auto-hide
 * értéket, és egy régebbi, a kulcsot még nem ismerő fájl az alapértékkel töltődik be —
 * átírás nélkül.
 */
export async function loadConfig(dir: string): Promise<Config> {
  const raw = await readRaw(configPath(dir))

  if (raw !== undefined) {
    const parsed = parseObject(raw)
    if (parsed === undefined) return { ...DEFAULT_CONFIG }
    const { hotkey, hideAfterLastDecision } = parsed
    return {
      hotkey: typeof hotkey === 'string' && hotkey.trim() !== '' ? hotkey : DEFAULT_HOTKEY,
      hideAfterLastDecision:
        typeof hideAfterLastDecision === 'boolean' ? hideAfterLastDecision : DEFAULT_CONFIG.hideAfterLastDecision,
    }
  }

  const config: Config = { ...DEFAULT_CONFIG }
  try {
    await writeObject(dir, { ...config })
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
 * tett bele, az nem veszhet el egy pipa miatt. Elrontott fájlba nem írunk — ugyanaz a
 * garancia, mint a betöltésnél; a változás ilyenkor csak a futó appban él.
 */
export async function updateConfig(dir: string, patch: Partial<Config>): Promise<boolean> {
  const raw = await readRaw(configPath(dir))
  const current = raw === undefined ? { ...DEFAULT_CONFIG } : parseObject(raw)
  if (current === undefined) {
    console.error('[claudeswitcher] the config file is not valid JSON; not overwriting it')
    return false
  }
  try {
    await writeObject(dir, { ...current, ...patch })
    return true
  } catch (error) {
    console.error('[claudeswitcher] could not write the config file', error)
    return false
  }
}
