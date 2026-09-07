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

export function updateSettingsFile(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const key = path.resolve(filePath)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  // A következő hívónak arra kell várnia, hogy a fájlművelet *befejeződjön*, a
  // sikerére nem — ezért fut a lánc hiba után is tovább.
  const next = previous.then(
    () => writeMerged(filePath, patch),
    () => writeMerged(filePath, patch),
  )
  writeQueues.set(key, next.catch(() => undefined))
  return next
}

/**
 * Atomikus merge-írás: temp fájl + rename. Parse-olhatatlan meglévő fájlnál
 * dob, és nem ír — inkább ne módosítsunk semmit, mint hogy elveszítsük a
 * felhasználó beállításait.
 */
async function writeMerged(
  filePath: string,
  patch: Record<string, unknown>,
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

  const merged = mergeSettings(existing, patch)
  // Egyedi név processzenként ÉS híváson belül: a pid önmagában nem elég, mert
  // egy processzen belüli két írás ugyanarra a temp útvonalra esne.
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    await rename(temp, filePath)
  } catch (error) {
    // Ne hagyjunk törmeléket a ~/.claude/-ban. A célfájl érintetlen — ez a lényeg.
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
