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
}

/** A config fájl útvonala az Electron `userData` könyvtárában. */
export function configPath(dir: string): string {
  return path.join(dir, 'config.json')
}

/**
 * Beolvassa a beállításokat, és soha nem dob.
 *
 * Ha a fájl nincs meg, kiírja az alapértékekkel — különben a felhasználó nem tudná, mit és
 * hol szerkeszthet. Ha a fájl elromlott, az alapértékeket adja, de NEM írja felül: a kézi
 * szerkesztés maradjon meg, hogy ki lehessen javítani. Egy írhatatlan könyvtár sem
 * akadályozza meg az indulást.
 */
export async function loadConfig(dir: string): Promise<Config> {
  const file = configPath(dir)

  let raw: string | undefined
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    raw = undefined
  }

  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const { hotkey } = parsed as { hotkey?: unknown }
        if (typeof hotkey === 'string' && hotkey.trim() !== '') return { hotkey }
      }
    } catch {
      // Elrontott fájl: alapérték, de érintetlenül hagyjuk.
    }
    return { hotkey: DEFAULT_HOTKEY }
  }

  const config: Config = { hotkey: DEFAULT_HOTKEY }
  try {
    await mkdir(dir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    console.error('[claudeswitcher] could not write the config file; using defaults', error)
  }
  return config
}
