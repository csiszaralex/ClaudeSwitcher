import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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
      isPlainObject(value) && isPlainObject(current)
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
 * A Map csak annyi bejegyzést tart, ahány külön settings fájlt írunk (a
 * felhasználói és a projektszintű), tehát nem nő korlátlanul.
 */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * Atomikus, sorba állított, parse-biztos olvasás–transzformálás–írás. A `transform` a már
 * beolvasott objektumot kapja, és a kiírandót adja vissza.
 *
 * Azért kell a merge-patch mellé, mert az integráció eltávolítása kulcsokat töröl, amit
 * egy merge-patch nem tud kifejezni. Az `updateSettingsFile`-lal azonos sort használ, így
 * a kettő ugyanarra a fájlra nem tudja egymás írását eldobni.
 */
export function transformSettingsFile(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const key = path.resolve(filePath)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  // A következő hívónak arra kell várnia, hogy a fájlművelet *befejeződjön*, a
  // sikerére nem — ezért fut a lánc hiba után is tovább.
  const next = previous.then(
    () => writeTransformed(filePath, transform),
    () => writeTransformed(filePath, transform),
  )
  writeQueues.set(key, next.catch(() => undefined))
  return next
}

export function updateSettingsFile(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  return transformSettingsFile(filePath, (existing) => mergeSettings(existing, patch))
}

/**
 * Parse-olhatatlan meglévő fájlnál dob, és NEM hívja a transzformációt és nem ír — inkább
 * ne módosítsunk semmit, mint hogy elveszítsük a felhasználó beállításait.
 */
async function writeTransformed(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  let existing: Record<string, unknown> = {}

  let raw: string | undefined
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    raw = undefined
  }

  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`Cannot parse existing settings at ${filePath}; refusing to write`, { cause })
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`Settings at ${filePath} is not a JSON object; refusing to write`)
    }
    existing = parsed
  }

  const next = transform(existing)
  // Egyedi név processzenként ÉS híváson belül: a pid önmagában nem elég.
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await rename(temp, filePath)
  } catch (error) {
    // Ne hagyjunk törmeléket a ~/.claude/-ban. A célfájl érintetlen — ez a lényeg.
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
