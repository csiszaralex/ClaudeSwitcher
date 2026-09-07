import { readFile, rename, writeFile } from 'node:fs/promises'
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
    const current = out[key]
    out[key] =
      isPlainObject(value) && isPlainObject(current)
        ? mergeSettings(current, value)
        : value
  }
  return out
}

/**
 * Atomikus merge-írás: temp fájl + rename. Parse-olhatatlan meglévő fájlnál
 * dob, és nem ír — inkább ne módosítsunk semmit, mint hogy elveszítsük a
 * felhasználó beállításait.
 */
export async function updateSettingsFile(
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
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`)
  await writeFile(temp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  await rename(temp, filePath)
}
