import type { SessionStatus } from '@claudeswitcher/core'
import type { WeeklyReset } from '../shared/excluded-sessions.js'
import type { MarkerTone } from './session-marker.js'
import { filterRows, type SearchableRow } from './session-search.js'
import { untilClock } from './until-time.js'

/**
 * The list's cleanup keys: Backspace clears a finish's ✓ and the due mark of a session back from a
 * timed exclusion, Delete moves a session out of the list into the excluded group at its bottom, or
 * brings it back, and Shift+Delete opens the bar that excludes it until a time (`UntilBar.tsx`).
 * Pure; App owns the keys (in its window
 * handler `onKey`, outside every text field, so both keys still edit the search field and a deny
 * reason, and not in the peek), the group's open state (closed on every `shown`), and sends the
 * changes to the main process, which checks them against the daemon's state.
 */

/** The fields of a keydown the keys read. */
interface KeyLike {
  key: string
  repeat: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** A plain key: no Ctrl, Alt (AltGr) or Meta, and no Shift either, so Shift+Delete is not taken; not held. */
function isPlain(event: KeyLike, key: string): boolean {
  return event.key === key && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

/**
 * The key that opens the time bar under the selected row (`UntilBar.tsx`), to exclude its session
 * until a time, or to give an excluded one a new time: Shift+Delete, no Ctrl, Alt or Meta, not held.
 * It never excludes by itself: only a time the bar confirms does.
 */
export function isTimedExcludeKey(event: KeyLike): boolean {
  return event.key === 'Delete' && event.shiftKey && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey
}

/**
 * The key that clears the selected row's ✓ and its due mark (`dueMarkOf`): a plain Backspace
 * (`isPlain`). No letter: the decision panel's buttons are letters (`decision-actions.ts`
 * `ACTION_BUTTONS`).
 */
export function isClearFinishKey(event: KeyLike): boolean {
  return isPlain(event, 'Backspace')
}

/** The markers of a finish's ✓: green unseen, blue seen (`session-marker.ts`). */
const FINISH_TONES: ReadonlySet<MarkerTone> = new Set<MarkerTone>(['done', 'seen'])

/**
 * Whether the row shows a finish's ✓ that Backspace clears: a row with a session whose marker is the
 * green or the blue ✓. Not a usage limit row (◷), whose turn finished too but which shows no ✓.
 */
export function showsFinishMark(row: { session?: unknown; marker: { tone: MarkerTone } }): boolean {
  return row.session !== undefined && FINISH_TONES.has(row.marker.tone)
}

/**
 * The key that moves the selected row's session out of the list, or an excluded one back: a plain
 * Delete (`isPlain`).
 */
export function isExcludeKey(event: KeyLike): boolean {
  return isPlain(event, 'Delete')
}

/** What ←/→ do around the excluded group (`groupArrow`). */
export type GroupArrow = 'open' | 'close' | 'to-header'

/**
 * ←/→ on the excluded group, as in a tree view (asked by the owner, 2026-11-22): → on the closed
 * group's header opens it; ← on one of the open group's rows selects the header; ← on the open
 * group's header closes it. `place` is where the selection is. Anything else: `undefined`, the
 * arrow does nothing. Only a plain arrow (`isPlain`): a held arrow acts once, so a held ← on a row
 * selects the header and does not go on to close the group.
 */
export function groupArrow(event: KeyLike, place: 'header' | 'group-row' | 'other', open: boolean): GroupArrow | undefined {
  if (isPlain(event, 'ArrowRight')) return place === 'header' && !open ? 'open' : undefined
  if (isPlain(event, 'ArrowLeft')) {
    if (place === 'group-row') return 'to-header'
    if (place === 'header' && open) return 'close'
  }
  return undefined
}

/** The excluded group's texts. */
export const EXCLUDED_TEXT = {
  /** The group's header, with the number of its rows. */
  group: (count: number): string => `Kizárt (${String(count)})`,
  groupTitle: 'Enter: kinyitás vagy becsukás. Egy kizárt soron a Delete visszahozza a sessiont, a Shift+Delete új időpontot ad neki.',
  /** The tag of an excluded session's row outside the group: one that waits, or one the search found. */
  tag: 'kizárt',
  tagTitle: 'Kizártad a listából, de amíg vár rád, itt marad. Delete: visszahozás.',
  /** The title of the tag on a row the search found in the group (`ListView.excludedMatches`). */
  matchTitle: 'Kizártad a listából, de a keresés megtalálja. Delete: visszahozás.',
  /** The tag of a session that came back because it started running, until the first jump to it. */
  returnedTag: 'kizárt, de fut',
  returnedTitle: 'Kizártad, de elkezdett futni, ezért visszakerült a listába. Az első Enter után eltűnik ez a jelölés.',
  /** The tag of a session excluded while running, wherever its row shows. */
  whileRunningTag: 'futáskor se jön vissza',
  whileRunningTitle:
    'Futás közben zártad ki, ezért akkor sem jön vissza, ha újra elindul: csak a Delete hozza vissza, vagy a megadott időpont, ha adtál meg.',
  /** The tag of a session excluded until a time, wherever its row shows: until when (`untilClock`). */
  untilTag: (until: number, now: number): string => `${untilClock(until, now)}-ig`,
  untilTitle: (until: number, now: number): string =>
    `Eddig zártad ki: ${untilClock(until, now)}. Akkor visszakerül a listába, teendő jelöléssel. Shift+Delete: új időpont. Delete: visszahozás most.`,
  /** The tag of a session whose exclusion time has passed, until the first jump to it or a Backspace on its row. */
  dueTag: 'teendő',
  dueTitle: (until: number, now: number): string =>
    `Eddig zártad ki: ${untilClock(until, now)}. Az első Enter vagy a Backspace után eltűnik ez a jelölés.`,
} as const

/** The excluded sessions as the list reads them (`renderer/useExcludedSessions.ts` `readExcludedSessions`). */
export interface ExclusionState {
  /** The excluded session ids. */
  excluded: ReadonlySet<string>
  /** Those of them excluded while running (`whileRunning`), which stay out when they run again. */
  whileRunning: ReadonlySet<string>
  /** The sessions that came back because they started running, until the first jump to each. */
  returned: ReadonlySet<string>
  /** Those of the excluded sessions excluded until a time, to the time (epoch ms). */
  until: ReadonlyMap<string, number>
  /**
   * The sessions whose exclusion time has passed, to that time: back in the list with the due mark,
   * until the first jump to each or a Backspace on its row.
   */
  due: ReadonlyMap<string, number>
  /** The weekly reset from `config.json`, for the bar's preset and the `limit` phrase; `undefined` while not set. */
  weeklyReset: WeeklyReset | undefined
}

/**
 * The selection id of the excluded group's header. Not a session id: the registry's ids are UUIDs,
 * and no UUID starts with a NUL.
 */
export const EXCLUDED_GROUP_ID = '\u0000excluded-group'

/** The part of a row the excluded group reads; `rows.ts` `Row` fits it. */
interface GroupableRow extends SearchableRow {
  sessionId: string
  status: SessionStatus
  decisions: readonly unknown[]
}

/**
 * Whether the row goes into the excluded group: its session is excluded, and nothing of it waits
 * for the user. The safety rule: a session with a pending request (`decisions`, a released one
 * included) or a wait the app holds no request for (`status` `waiting`, `rows.ts` `waitsOutsideApp`)
 * stays in the list, with the `kizárt` tag (`showsExcludedTag`), so it never blocks unseen; once
 * nothing waits, it goes back into the group. A row without a session (only its requests) is never
 * excluded.
 */
export function inExcludedGroup(row: GroupableRow, excluded: ReadonlySet<string>): boolean {
  return row.session !== undefined && excluded.has(row.sessionId) && row.decisions.length === 0 && row.status !== 'waiting'
}

/** Whether the row shows in the list with the `kizárt` tag: its session is excluded, but something of it waits (`inExcludedGroup`). */
export function showsExcludedTag(row: GroupableRow, excluded: ReadonlySet<string>): boolean {
  return row.session !== undefined && excluded.has(row.sessionId) && !inExcludedGroup(row, excluded)
}

/** Where a row shows (`listView`): above the group, among the search's matches in the group, or in the open group. */
export type RowPlace = 'list' | 'match' | 'group'

/** A small tag after a row's name, with its tooltip. */
export interface RowTag {
  text: string
  title: string
}

/**
 * The time of the row's due mark, while it shows one: its session's exclusion time has passed, and
 * it is not excluded again. `undefined` otherwise, and on a row without a session.
 */
export function dueMarkOf(row: { sessionId: string; session?: unknown }, exclusion: ExclusionState): number | undefined {
  if (row.session === undefined || exclusion.excluded.has(row.sessionId)) return undefined
  return exclusion.due.get(row.sessionId)
}

/**
 * The tags a row carries for its exclusion, in their order, at `now` (the until tag names its day
 * relative to today). The `kizárt` tag on an excluded row that stays in the list because something
 * of it waits (`showsExcludedTag`), and on a row the search found in the group, which shows dimmed
 * among the matches; none in the open group, whose header says it already. After it, on a session
 * excluded until a time, the until tag (`csütörtök 08:00-ig`), and on a session excluded while
 * running, the `futáskor se jön vissza` tag, both wherever the row shows, so in the group alone
 * too. On a session that came back because it started running (not excluded any more), the
 * `kizárt, de fut` tag; on one whose time has passed (`dueMarkOf`), the `teendő` tag. A row without
 * a session carries none.
 */
export function exclusionTags(row: GroupableRow, place: RowPlace, exclusion: ExclusionState, now: number): RowTag[] {
  if (row.session === undefined) return []
  const tags: RowTag[] = []
  if (place === 'match') tags.push({ text: EXCLUDED_TEXT.tag, title: EXCLUDED_TEXT.matchTitle })
  else if (place === 'list' && showsExcludedTag(row, exclusion.excluded)) tags.push({ text: EXCLUDED_TEXT.tag, title: EXCLUDED_TEXT.tagTitle })
  const excluded = exclusion.excluded.has(row.sessionId)
  const until = excluded ? exclusion.until.get(row.sessionId) : undefined
  if (until !== undefined) tags.push({ text: EXCLUDED_TEXT.untilTag(until, now), title: EXCLUDED_TEXT.untilTitle(until, now) })
  if (excluded && exclusion.whileRunning.has(row.sessionId)) {
    tags.push({ text: EXCLUDED_TEXT.whileRunningTag, title: EXCLUDED_TEXT.whileRunningTitle })
  }
  if (!excluded && exclusion.returned.has(row.sessionId)) {
    tags.push({ text: EXCLUDED_TEXT.returnedTag, title: EXCLUDED_TEXT.returnedTitle })
  }
  const due = dueMarkOf(row, exclusion)
  if (due !== undefined) tags.push({ text: EXCLUDED_TEXT.dueTag, title: EXCLUDED_TEXT.dueTitle(due, now) })
  return tags
}

/** The rows the list shows above the excluded group, in their order: every row not in the group. */
export function keptRows<R extends GroupableRow>(rows: readonly R[], excluded: ReadonlySet<string>): R[] {
  return rows.filter((row) => !inExcludedGroup(row, excluded))
}

/** What the list shows. */
export interface ListView<R> {
  /** The rows above the group (`keptRows`), or while the search is open, its matches among them. */
  rows: R[]
  /**
   * While the search is open, its matches among the excluded group's rows, in the list's order,
   * after `rows`; empty while it is closed.
   */
  excludedMatches: R[]
  /** The excluded group's rows, in the list's order; empty while the group's header does not show. */
  group: R[]
  /** Whether the group's header shows: it has rows, and the search is closed. */
  groupShown: boolean
  /** Whether the group's rows show under the header. */
  groupOpen: boolean
  /**
   * The selectable items in order (`selection.ts` works on them): the rows, the search's matches
   * in the group, the header (`EXCLUDED_GROUP_ID`), then the group's rows while it is open.
   */
  ids: string[]
}

/**
 * The list from all rows (`rows.ts` `buildRows`), the excluded session ids, the search's query
 * (`undefined` while it is closed) and whether the group is open. The search finds the rows above
 * the group first, the tagged ones included, then the group's rows (`excludedMatches`, which App
 * dims and tags), so the first match, the one the search selects and Enter opens, is a session
 * that is not excluded whenever one matches. The group's header does not show while the search is
 * open: its matches are among the search's rows already.
 */
export function listView<R extends GroupableRow>(
  allRows: readonly R[],
  excluded: ReadonlySet<string>,
  query: string | undefined,
  open: boolean,
): ListView<R> {
  const kept = keptRows(allRows, excluded)
  const inGroup = allRows.filter((row) => inExcludedGroup(row, excluded))
  const rows = query === undefined ? kept : filterRows(kept, query)
  const excludedMatches = query === undefined ? [] : filterRows(inGroup, query)
  const groupShown = query === undefined && inGroup.length > 0
  const groupOpen = groupShown && open
  const ids = [
    ...rows.map((row) => row.sessionId),
    ...excludedMatches.map((row) => row.sessionId),
    ...(groupShown ? [EXCLUDED_GROUP_ID] : []),
    ...(groupOpen ? inGroup.map((row) => row.sessionId) : []),
  ]
  return { rows, excludedMatches, group: groupShown ? inGroup : [], groupShown, groupOpen, ids }
}

/** Where an item is among the list's items (`ListView.ids`): above the group's header, in the group, or not listed. */
function sideOf(ids: readonly string[], id: string): 'list' | 'group' | 'gone' {
  const at = ids.indexOf(id)
  if (at === -1) return 'gone'
  const header = ids.indexOf(EXCLUDED_GROUP_ID)
  return header === -1 || at < header ? 'list' : 'group'
}

/**
 * Where the selection goes when Delete has moved the row `moved` and the list's items change from
 * `before` to `after`. A selection on another row stays while that row is listed. A selection on the
 * moved row stays only while the row stays on its side of the group's header (a waiting row, which
 * keeps its place and only gains or loses its tag, `showsExcludedTag`); a row that went into the
 * group or came out of it leaves the selection behind, on the next item after it that is still
 * listed, else on the nearest one before it. So after Delete the selection is on the row below; after
 * the last row it is on the group's header when the group was there already (where a second Delete
 * does nothing), else, on the first exclusion, which only now adds the header, on the row above.
 * Never on a row the user did not see selected, and a second Delete does not undo the first, except
 * on a row that stays in place (a waiting one, whose tag shows the change). While the search is open
 * there is no header, so a row moved by Delete stays among the matches, on the same side, and keeps
 * the selection: it only changes between the kept matches and the excluded ones, and its look and
 * tag show the change.
 */
export function selectionAfterChange(
  before: readonly string[],
  after: readonly string[],
  selected: string | undefined,
  moved: string,
): string | undefined {
  if (selected === undefined) return undefined
  const stays = selected === moved ? sideOf(before, moved) === sideOf(after, moved) : after.includes(selected)
  if (stays) return selected
  const at = before.indexOf(selected)
  if (at === -1) return selected
  const listed = new Set(after.filter((id) => id !== moved))
  return before.slice(at + 1).find((id) => listed.has(id)) ?? before.slice(0, at).findLast((id) => listed.has(id))
}
