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

interface SessionLike {
  sessionId: string
  status: string
}

interface DecisionLike {
  id: string
  sessionId: string
}

/**
 * Az első várakozó session azonosítója a lista sorrendjében. A daemon a várakozókat előre, a
 * legrégebben várót legelőre rendezi, tehát ez a legrégebben váró. Egy tartott döntés is
 * várakozásnak számít, akkor is, ha a session `status`-a még nem követte.
 */
function firstWaiting(
  sessions: readonly SessionLike[],
  decisions: readonly DecisionLike[],
  skip?: string,
): string | undefined {
  const held = new Set(decisions.map((d) => d.sessionId))
  return sessions.find((s) => s.sessionId !== skip && (s.status === 'waiting' || held.has(s.sessionId)))
    ?.sessionId
}

/**
 * Kijelölés az overlay megjelenésekor: a legrégebben várakozó session — a felhasználó
 * munkamenete „megnyitom, eldöntöm a legrégebbit". Ha senki nem vár, marad a mostani.
 */
export function selectOnShow(
  sessions: readonly SessionLike[],
  decisions: readonly DecisionLike[],
  current: string | undefined,
): string | undefined {
  return firstWaiting(sessions, decisions) ?? current
}

export interface AfterDecision {
  /** Erre lépjen a kijelölés; ha nincs, marad, ahol volt. */
  select?: string | undefined
  /** Rejtőzzön-e el az overlay. */
  hide: boolean
}

/**
 * Mi történjen egy appból hozott SIKERES döntés után.
 *
 * A `sessions` és a `decisions` lehet egy lépéssel lemaradva: a döntés válasza és a daemon
 * következő állapota külön utazik. Ezért az eldöntött kérést azonosító szerint kizárjuk, és az
 * eldöntött sessiont sem tekintjük várakozónak — a daemon úgyis a nem-várók tetejére teszi.
 * Kivétel, ha ugyanannak a sessionnek van MÁSIK függő kérése (párhuzamos tool-hívások): akkor
 * ott maradunk, és el sem rejtőzünk, mert van még mit eldönteni.
 */
export function nextAfterDecision(
  sessions: readonly SessionLike[],
  decisions: readonly DecisionLike[],
  decided: DecisionLike,
  hideEnabled: boolean,
): AfterDecision {
  const rest = decisions.filter((d) => d.id !== decided.id)
  if (rest.some((d) => d.sessionId === decided.sessionId)) return { select: decided.sessionId, hide: false }
  const next = firstWaiting(sessions, rest, decided.sessionId)
  if (next !== undefined) return { select: next, hide: false }
  return { hide: hideEnabled }
}
