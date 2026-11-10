import { recentlyTyped } from './key-guard.js'

/**
 * The index of the selected session in the current list, or -1 if the list is empty.
 *
 * The selection is tracked by session id, not by index. The list is sorted (waiting sessions jump
 * to the top), so an index-based selection would silently point to a DIFFERENT session after a
 * reorder, and Enter would jump to the wrong window. If the selected session is gone, it falls
 * back to the first one.
 */
export function resolveSelectedIndex(
  ids: readonly string[],
  selectedId: string | undefined,
): number {
  if (ids.length === 0) return -1
  const index = selectedId === undefined ? -1 : ids.indexOf(selectedId)
  return index === -1 ? 0 : index
}

/** Moves the selection by `delta` steps, stopping at the ends of the list. */
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
  /** The app has already released it (`PERMISSION_RELEASE_AFTER_MS`): from here only VS Code can decide. */
  released: boolean
}

/**
 * The id of the first waiting session in list order, on two tiers. The daemon sorts the waiting
 * sessions first and the longest-waiting one to the very front, so within a tier the first is the
 * one waiting longest.
 *
 * Tier 1: the app can still decide something. The session has a decision that is not released, or
 *    it has no held decision but its `status` is `waiting` (a Notification wait, e.g. a question in
 *    the terminal). A held decision counts as waiting even if the `status` has not caught up yet.
 * Tier 2: every held decision of the session is released. The daemon shows such a session as
 *    `waiting` too (its `#pending` keeps the released decision as well), so the `status` does not
 *    matter here: this tier is the fallback only when nobody is on tier 1.
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
 * The selection when the overlay appears: the session waiting longest, matching the user's flow
 * "open it, decide the oldest". It jumps to a released request only if nothing else waits (see
 * `firstWaiting`). If nobody waits, the current selection stays.
 */
export function selectOnShow(
  sessions: readonly SessionLike[],
  decisions: readonly DecisionLike[],
  current: string | undefined,
): string | undefined {
  return firstWaiting(sessions, decisions) ?? current
}

export interface AfterDecision {
  /** The selection moves here; if absent, it stays where it was. */
  select?: string | undefined
  /** Whether the overlay hides. */
  hide: boolean
}

/**
 * What happens after a SUCCESSFUL decision made in the app.
 *
 * `sessions` and `decisions` can be one step behind: the decision's reply and the daemon's next
 * state travel separately. So the decided request is excluded by id, and the decided session is
 * not taken as waiting either; the daemon puts it on top of the non-waiting ones anyway.
 * The exception is when the same session has ANOTHER request that can still be decided (parallel
 * tool calls): then the selection stays there and the overlay does not hide, because there is still
 * something to decide. A released sibling is no reason to stay.
 */
export function nextAfterDecision(
  sessions: readonly SessionLike[],
  decisions: readonly DecisionLike[],
  decided: DecisionLike,
  hideEnabled: boolean,
): AfterDecision {
  const rest = decisions.filter((d) => d.id !== decided.id)
  // Only a sibling that can still be decided holds the selection: the app can no longer decide a released one.
  if (rest.some((d) => d.sessionId === decided.sessionId && !d.released)) return { select: decided.sessionId, hide: false }
  const next = firstWaiting(sessions, rest, decided.sessionId)
  if (next !== undefined) return { select: next, hide: false }
  return { hide: hideEnabled }
}

interface ArrivalState {
  /** The rows in list order (rows.ts `buildRows`). */
  sessions: readonly SessionLike[]
  decisions: readonly DecisionLike[]
  /** The id of the selected row, as the list resolves it (`resolveSelectedIndex`). */
  selectedId: string | undefined
  /** See key-guard.ts `KeyHistory.lastTypedAt`. */
  lastTypedAt: number | undefined
  now: number
}

interface ArrivalInput extends ArrivalState {
  /** The ids of the requests already known in the previous state: anything not among them just arrived. */
  known: ReadonlySet<string>
}

/**
 * Where the selection jumps when a new request the app can decide has arrived; `undefined` if it stays.
 *
 * It jumps only if the selected row has no held decision (not even a released one: that is for the
 * user to read), and the user has not typed in the last `TYPING_COOLDOWN_MS`. An open form (deny,
 * rule, question, plan) exists only with a held decision, so the first condition covers it. The
 * target is never a released request. With several new requests the first row in list order wins.
 *
 * The jump cannot decide by accident: the new request's panel mounts again (App's `key={decision.id}`),
 * and its allowing buttons and key letters are not armed for `SHORTCUT_ARM_MS` (DecisionPanel `mountArmedAt`).
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
 * `selectOnArrival` with a memory of the previous state: every call measures the new requests
 * against the ones seen so far and remembers the current ones. A request can pull the selection
 * only on arrival: if the selection had to stay then, it does not jump there later either; its row
 * in the list shows that it waits.
 */
export function trackArrivals(): (state: ArrivalState) => string | undefined {
  let known: ReadonlySet<string> = new Set()
  return (state) => {
    const next = selectOnArrival({ ...state, known })
    known = new Set(state.decisions.map((d) => d.id))
    return next
  }
}
