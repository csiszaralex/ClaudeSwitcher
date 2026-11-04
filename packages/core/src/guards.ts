/**
 * Apró, mindenhol használt őrök a nem megbízható bemenethez (hook-törzs, registry-fájl, IPC,
 * WebSocket üzenet). IO-mentes, a `/browser` belépési pont is exportálja.
 */

/** Igaz, ha az érték egy objektum, de nem `null` és nem tömb: kulcs szerint olvasható. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A szöveg, ha nem üres; minden más `undefined`. A csak szóközből álló szöveget átengedi. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Egysoros szöveg: a szóközök és sortörések egy szóközzé lapítva, a két vége vágva. Üresen `undefined`. */
export function flatText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat === '' ? undefined : flat
}

/** The text cut to at most `max` characters: a longer one keeps `max - 1` and ends in `…`. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Egy útvonal utolsó nem üres tagja, `/` és `\` mentén is. Ha nincs ilyen, `undefined`. */
export function lastPathSegment(path: string): string | undefined {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1]
}
