import { recentlyTyped } from './key-guard.js'

/**
 * A kiválasztott session indexe a jelenlegi listában, vagy -1, ha a lista üres.
 *
 * A kiválasztást session-azonosító szerint követjük, nem index szerint. A lista
 * rendezett (a várakozó sessionök felülre ugranak), így egy index-alapú kiválasztás
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
  /** Az app már elengedte (`PERMISSION_RELEASE_AFTER_MS`): innen csak a VSCode dönthet. */
  released: boolean
}

/**
 * Az első várakozó session azonosítója a lista sorrendjében, két szinten. A daemon a várakozókat
 * előre, a legrégebben várót legelőre rendezi, tehát szinten belül az első a legrégebben váró.
 *
 * 1. szint: az app még eldönthet valamit. Van nem elengedett döntése, vagy nincs tartott döntése,
 *    de a `status`-a `waiting` (Notification-várakozás, pl. kérdés a terminálban). Egy tartott
 *    döntés akkor is várakozás, ha a `status` még nem követte.
 * 2. szint: minden tartott döntése elengedett. A daemon az ilyet is `waiting`-nek mutatja (a
 *    `#pending` az elengedett döntést is tartja), ezért a `status` itt nem számít: ide csak akkor
 *    esünk vissza, ha az 1. szinten senki nincs.
 */
function firstWaiting(
  sessions: readonly SessionLike[],
  decisions: readonly DecisionLike[],
  skip?: string,
): string | undefined {
  const held = new Set<string>()
  const decidable = new Set<string>()
  for (const d of decisions) {
    held.add(d.sessionId)
    if (!d.released) decidable.add(d.sessionId)
  }
  const candidates = sessions.filter((s) => s.sessionId !== skip)
  const first = candidates.find(
    (s) => decidable.has(s.sessionId) || (!held.has(s.sessionId) && s.status === 'waiting'),
  )
  return (first ?? candidates.find((s) => held.has(s.sessionId)))?.sessionId
}

/**
 * Kijelölés az overlay megjelenésekor: a legrégebben várakozó session, a felhasználó
 * munkamenete „megnyitom, eldöntöm a legrégebbit". Elengedett kérésre csak akkor ugrik, ha más nem
 * vár (lásd `firstWaiting`). Ha senki nem vár, marad a mostani.
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
 * eldöntött sessiont sem tekintjük várakozónak, a daemon úgyis a nem-várók tetejére teszi.
 * Kivétel, ha ugyanannak a sessionnek van MÁSIK, még eldönthető kérése (párhuzamos tool-hívások): akkor
 * ott maradunk, és el sem rejtőzünk, mert van még mit eldönteni. Egy elengedett testvér nem ok a
 * maradásra.
 */
export function nextAfterDecision(
  sessions: readonly SessionLike[],
  decisions: readonly DecisionLike[],
  decided: DecisionLike,
  hideEnabled: boolean,
): AfterDecision {
  const rest = decisions.filter((d) => d.id !== decided.id)
  // Csak a még eldönthető testvér tart helyben: egy elengedettet az app már nem dönthet el.
  if (rest.some((d) => d.sessionId === decided.sessionId && !d.released)) return { select: decided.sessionId, hide: false }
  const next = firstWaiting(sessions, rest, decided.sessionId)
  if (next !== undefined) return { select: next, hide: false }
  return { hide: hideEnabled }
}

interface ArrivalState {
  /** A sorok a lista sorrendjében (rows.ts `buildRows`). */
  sessions: readonly SessionLike[]
  decisions: readonly DecisionLike[]
  /** A kijelölt sor azonosítója, ahogy a lista feloldja (`resolveSelectedIndex`). */
  selectedId: string | undefined
  /** Lásd key-guard.ts `KeyHistory.lastTypedAt`. */
  lastTypedAt: number | undefined
  now: number
}

interface ArrivalInput extends ArrivalState {
  /** Az előző állapotban már ismert kérések azonosítói: ami nincs köztük, az most érkezett. */
  known: ReadonlySet<string>
}

/**
 * Hova ugorjon a kijelölés, ha új, appból eldönthető kérés érkezett; `undefined`, ha maradjon.
 *
 * Csak akkor ugrik, ha a kijelölt sornak nincs tartott döntése (elengedett sem: az a felhasználó
 * olvasnivalója), és a felhasználó nem gépelt az utolsó `TYPING_COOLDOWN_MS`-ben. Nyitott űrlap
 * (tiltás, szabály, kérdés, terv) csak tartott döntésnél van, azt tehát az első feltétel fedi. A cél
 * soha nem elengedett kérés. Több új kérésnél a lista sorrendjében első sor nyer.
 *
 * Az ugrás nem dönthet véletlenül: az új kérés panelje újra mountol (az App `key={decision.id}`-ja),
 * és az engedélyező gombjai meg a betűjelei `SHORTCUT_ARM_MS`-ig nem élesek (DecisionPanel `mountArmedAt`).
 */
export function selectOnArrival(input: ArrivalInput): string | undefined {
  const arrived = new Set(input.decisions.filter((d) => !d.released && !input.known.has(d.id)).map((d) => d.sessionId))
  if (arrived.size === 0) return undefined
  if (recentlyTyped(input.lastTypedAt, input.now)) return undefined
  const selected = input.selectedId
  if (selected !== undefined && input.decisions.some((d) => d.sessionId === selected)) return undefined
  return input.sessions.find((s) => arrived.has(s.sessionId))?.sessionId
}

/**
 * A `selectOnArrival` az előző állapot emlékével: minden hívás az addig látott kérésekhez méri az
 * újakat, és megjegyzi a mostaniakat. Egy kérés csak az érkezésekor ránthat: ha akkor maradni
 * kellett, később sem ugrunk rá: a sora a listában jelzi, hogy vár.
 */
export function trackArrivals(): (state: ArrivalState) => string | undefined {
  let known: ReadonlySet<string> = new Set()
  return (state) => {
    const next = selectOnArrival({ ...state, known })
    known = new Set(state.decisions.map((d) => d.id))
    return next
  }
}
