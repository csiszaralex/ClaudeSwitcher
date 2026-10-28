import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from './guards.js'

/**
 * Az a néhány fájlművelet, amit ez a modul használ. Teszteléshez cserélhető: egy foglalt
 * fájlt (EBUSY), egy félbecsonkolt olvasást vagy egy közben író másik folyamatot valódi
 * fájlrendszeren nem lehet determinisztikusan előidézni.
 */
export interface SettingsFs {
  readFile(file: string, encoding: 'utf8'): Promise<string>
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(file: string): Promise<void>
  stat(file: string): Promise<{ mtimeMs: number; size: number }>
  copyFile(from: string, to: string, mode: number): Promise<void>
}

const nodeFs: SettingsFs = { readFile, writeFile, rename, unlink, stat, copyFile }

export interface SettingsWriteOptions {
  /** Alapból a valódi `node:fs/promises`. */
  fs?: SettingsFs
  /**
   * Egyszeri biztonsági másolat a meglévő fájlról az első módosító írás előtt. Alapból igen;
   * a saját config fájlunknak nem kell.
   */
  backup?: boolean
}

/** A biztonsági másolat a célfájl mellett, ezzel az utótaggal. */
export const SETTINGS_BACKUP_SUFFIX = '.claudeswitcher-backup'

/** Ennyiszer olvassuk újra a meglévő, de üres fájlt, mielőtt az írást elutasítjuk. */
const EMPTY_READ_RETRIES = 3
const EMPTY_READ_DELAY_MS = 50
/** Ennyiszer kezdjük újra a teljes olvasás, transzformálás, írás kört, ha közben más írt. */
const CONFLICT_ATTEMPTS = 3

/** A Node fájlrendszer-hiba kódja (`ENOENT`, `EBUSY`…), ha van. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Igaz, ha a hiba azt jelenti, hogy a fájl nincs meg. Minden más hiba valódi hiba. */
export function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

/**
 * Rekurzív merge. Objektumokat mélyen egyesít, tömböket és skalárokat cserél.
 * A tömb-csere szándékos: a hook-konfigot idempotensen akarjuk újraírni, nem
 * duplikálni minden telepítéskor.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    // A `__proto__` értékadása a prototípus-settert hívná adatkulcs létrehozása
    // helyett, és a payload némán eltűnne. Nem valós Claude Code beállításkulcs,
    // de a csendes adatvesztést nem hagyjuk a kódban.
    if (key === '__proto__') continue
    const current = out[key]
    out[key] =
      isRecord(value) && isRecord(current)
        ? mergeSettings(current, value)
        : value
  }
  return out
}

/**
 * Célfájlonkénti sorbaállítás.
 *
 * Enélkül két egyidejű hívás ugyanarra a fájlra összefésült, olvashatatlan
 * JSON-t hagyna maga után — pont az a katasztrófa, amit ez a modul megelőzni
 * hivatott —, ráadásul a második beolvasás lemaradna az első írásáról, tehát az
 * egyik patch akkor is elveszne, ha a fájl épen marad.
 *
 * A Map csak annyi bejegyzést tart, ahány külön fájlt írunk vele (a felhasználói
 * settings.json és a desktop app config fájlja), tehát nem nő korlátlanul.
 */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * Atomikus, sorba állított, parse-biztos olvasás, transzformálás, írás. A `transform` a már
 * beolvasott objektumot kapja, és a kiírandót adja vissza. Ütközésnél újra lefut, tehát
 * tisztának és megismételhetőnek kell lennie.
 *
 * Azért kell a merge-patch mellé, mert az integráció eltávolítása kulcsokat töröl, amit
 * egy merge-patch nem tud kifejezni. Az `updateSettingsFile`-lal azonos sort használ, így
 * a kettő ugyanarra a fájlra nem tudja egymás írását eldobni.
 */
export function transformSettingsFile(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
  options: SettingsWriteOptions = {},
): Promise<void> {
  const key = path.resolve(filePath)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  // A következő hívónak arra kell várnia, hogy a fájlművelet *befejeződjön*, a
  // sikerére nem. Ezért fut a lánc hiba után is tovább.
  const next = previous.then(
    () => writeTransformed(filePath, transform, options),
    () => writeTransformed(filePath, transform, options),
  )
  writeQueues.set(key, next.catch(() => undefined))
  return next
}

export function updateSettingsFile(
  filePath: string,
  patch: Record<string, unknown>,
  options: SettingsWriteOptions = {},
): Promise<void> {
  return transformSettingsFile(filePath, (existing) => mergeSettings(existing, patch), options)
}

/**
 * Atomikus írás: egyedi nevű ideiglenes fájl, majd átnevezés. A célfájl vagy a régi, vagy az új
 * tartalmat tartja, félkészet soha.
 *
 * A `beforeRename` az átnevezés előtti utolsó pillanatban dönthet úgy, hogy mégse írjunk: ilyenkor
 * a temp eltűnik, a célfájl érintetlen, és a visszatérési érték `false`.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: { fs?: SettingsFs; beforeRename?: () => Promise<boolean> } = {},
): Promise<boolean> {
  const fs = options.fs ?? nodeFs
  // Egyedi név processzenként ÉS híváson belül: a pid önmagában nem elég.
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, data, 'utf8')
    if (options.beforeRename !== undefined && !(await options.beforeRename())) {
      await fs.unlink(temp).catch(() => undefined)
      return false
    }
    await fs.rename(temp, filePath)
    return true
  } catch (error) {
    // Ne hagyjunk törmeléket a célkönyvtárban. A célfájl érintetlen, ez a lényeg.
    await fs.unlink(temp).catch(() => undefined)
    throw error
  }
}

/** A fájl állapota az olvasáskor: `undefined`, ha nem létezett. */
type Fingerprint = { mtimeMs: number; size: number } | undefined

async function fingerprint(fs: SettingsFs, filePath: string): Promise<Fingerprint> {
  try {
    const { mtimeMs, size } = await fs.stat(filePath)
    return { mtimeMs, size }
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

interface Snapshot {
  /** A nyers tartalom, vagy `undefined`, ha a fájl nem létezett. */
  raw: string | undefined
  existing: Record<string, unknown>
  seen: Fingerprint
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Beolvassa a fájlt, és csak akkor tekinti üres beállításnak, ha valóban nincs meg (ENOENT).
 *
 * Minden más olvasási hiba (EBUSY, EPERM, EACCES, EMFILE…) dob: régen `{}` lett belőlük, és a
 * telepítés csak a mi kulcsainkkal írta felül a felhasználó teljes beállítását. Egy meglévő, de
 * üres fájl tipikusan egy másik író csonkolása és írása közötti pillanat, ezért rövid szünetekkel
 * újraolvassuk. Ha üres marad, az írást elutasítjuk, nem `{}`-ként kezeljük.
 *
 * A stat az olvasás ELŐTT fut: ha a kettő között más ír, az átnevezés előtti stat eltérést lát,
 * és a kör újraindul. Fordított sorrendben egy közbeeső írás észrevétlen maradhatna.
 */
async function readSnapshot(fs: SettingsFs, filePath: string): Promise<Snapshot> {
  for (let retry = 0; ; retry++) {
    const seen = await fingerprint(fs, filePath)
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) return { raw: undefined, existing: {}, seen: undefined }
      throw new Error(
        `Cannot read existing settings at ${filePath} (${errorCode(error) ?? 'unknown error'}); refusing to write`,
        { cause: error },
      )
    }
    if (raw.trim() === '') {
      if (retry < EMPTY_READ_RETRIES) {
        await delay(EMPTY_READ_DELAY_MS)
        continue
      }
      throw new Error(`Settings at ${filePath} exists but is empty; refusing to write`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`Cannot parse existing settings at ${filePath}; refusing to write`, { cause })
    }
    if (!isRecord(parsed)) {
      throw new Error(`Settings at ${filePath} is not a JSON object; refusing to write`)
    }
    return { raw, existing: parsed, seen }
  }
}

/**
 * Egyszeri biztonsági másolat. Az `COPYFILE_EXCL` miatt egy meglévő másolatot soha nem ír felül,
 * és a létezés ellenőrzése sem versenyezhet a másolással. Ha a másolat nem készülhet el, nem írunk.
 */
async function ensureBackup(fs: SettingsFs, filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}${SETTINGS_BACKUP_SUFFIX}`, constants.COPYFILE_EXCL)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return
    throw new Error(
      `Cannot back up settings at ${filePath} (${errorCode(error) ?? 'unknown error'}); refusing to write`,
      { cause: error },
    )
  }
}

/**
 * Parse-olhatatlan, nem objektum, olvashatatlan vagy üresen maradó meglévő fájlnál dob, és NEM
 * hívja a transzformációt és nem ír. Inkább ne módosítsunk semmit, mint hogy elveszítsük a
 * felhasználó beállításait.
 *
 * Optimista párhuzamosság: ha a fájl az olvasás és az átnevezés között megváltozott (mtime vagy
 * méret), a tempet eldobjuk, és a teljes kört a friss tartalomra ismételjük, korlátos számban.
 * Zárfájl nem segítene, mert a Claude Code és a szerkesztők nem ismerik. A legutolsó stat és az
 * átnevezés közötti rés megmarad: ezt csak egy közös zár zárhatná be.
 */
async function writeTransformed(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
  options: SettingsWriteOptions,
): Promise<void> {
  const fs = options.fs ?? nodeFs
  for (let attempt = 1; attempt <= CONFLICT_ATTEMPTS; attempt++) {
    const snapshot = await readSnapshot(fs, filePath)
    const data = JSON.stringify(transform(snapshot.existing), null, 2) + '\n'
    // Változatlan tartalmat nem írunk ki, így biztonsági másolat sem kell hozzá.
    if (data === snapshot.raw) return
    if (snapshot.raw !== undefined && options.backup !== false) await ensureBackup(fs, filePath)
    const written = await writeFileAtomic(filePath, data, {
      fs,
      beforeRename: async () => sameFingerprint(snapshot.seen, await fingerprint(fs, filePath)),
    })
    if (written) return
  }
  throw new Error(
    `Settings at ${filePath} kept being changed by another writer; gave up after ${String(CONFLICT_ATTEMPTS)} attempts`,
  )
}
