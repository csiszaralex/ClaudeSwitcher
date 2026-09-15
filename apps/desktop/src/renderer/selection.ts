/**
 * A kiválasztott session indexe a jelenlegi listában, vagy -1, ha a lista üres.
 *
 * A kiválasztást session-azonosító szerint követjük, nem index szerint. A lista
 * rendezett — a várakozó sessionök felülre ugranak —, így egy index-alapú kiválasztás
 * egy átrendeződéskor csendben egy MÁSIK sessionre mutatna, és az Enter rossz ablakra
 * ugrana. Ha a kiválasztott session eltűnt, az elsőre esünk vissza.
 */
export function resolveSelectedIndex(
  ids: readonly string[],
  selectedId: string | undefined,
): number {
  if (ids.length === 0) return -1
  const index = selectedId === undefined ? -1 : ids.indexOf(selectedId)
  return index === -1 ? 0 : index
}

/** A kiválasztás mozgatása `delta` lépéssel, a lista végein megállva. */
export function moveSelection(
  ids: readonly string[],
  selectedId: string | undefined,
  delta: number,
): string | undefined {
  if (ids.length === 0) return undefined
  const current = resolveSelectedIndex(ids, selectedId)
  const next = Math.min(Math.max(current + delta, 0), ids.length - 1)
  return ids[next]
}
