import { lastPathSegment } from '@claudeswitcher/core/browser'

/**
 * The search of the list (Ctrl+K): which rows a query finds. Pure; App owns the field and its state.
 *
 * A query matches a row when it is a substring of one of the row's names (`searchKeys`), ignoring
 * case and accents (`foldForSearch`). No fuzzy matching: a query finds exactly the rows whose names
 * contain it, so the user can predict what Enter opens.
 */

/** The part of a row the search reads; `rows.ts` `Row` fits it. */
export interface SearchableRow {
  /** The row's shown name (`rows.ts` `Row.name`, `shared/session-name.ts` `sessionName`). */
  name: string
  /**
   * The row's session. Its fields are `unknown`: the daemon's message is not checked field by field
   * (`state-message.ts` `sanitizeState`), so a wrong type must not throw here.
   */
  session?: { name?: unknown; cwd?: unknown; workspaceFolder?: unknown } | undefined
}

/** The key that opens the search, with Ctrl. */
const SEARCH_KEY = 'k'

/** The one key that opens the search on its own (`isSearchKey`). */
const SEARCH_SLASH = '/'

/** The keys that open the search (`isSearchChord`, `isSearchKey`), for the hint in the status bar. */
export const SEARCH_KEYS_LABEL = '/ vagy Ctrl+K'

/**
 * Whether a keydown is Ctrl+K, which opens the search. Not with Alt or Meta: AltGr on the Hungarian
 * layout arrives as Ctrl+Alt. Shift does not matter, so Caps Lock does not break it.
 */
export function isSearchChord(event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === SEARCH_KEY
}

/**
 * Whether a keydown is a plain `/`, which opens the search too: one key, and no decision panel
 * shortcut uses it (`decision-actions.ts`). Plain letters cannot: the panel's buttons are letters
 * (D denies at once), so the same key would search on one row and decide on another. Shift does not
 * matter, because `/` is Shift+6 on the Hungarian layout; Ctrl, Alt (AltGr) and Meta do. App calls
 * it only outside text fields, so a `/` typed into the search field or a reason stays a character.
 */
export function isSearchKey(event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return !event.ctrlKey && !event.altKey && !event.metaKey && event.key === SEARCH_SLASH
}

/**
 * The text as the search compares it: decomposed (NFD), without its combining marks, in lower case.
 * So "Ország" and "orszag" compare equal, and so do "Kőműves" and "komuves".
 */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * The names a row can be found by: its shown name, the daemon's name of its session
 * (`SessionView.name`: the registry's `name`, else the folder's name; it differs from the shown name
 * when the row shows the tab title), and the base name of the session's project folder
 * (`workspaceFolder`, else `cwd`). Empty ones are left out. A row without a session is named after
 * its request's folder already (`rows.ts` `buildRows`).
 */
export function searchKeys(row: SearchableRow): string[] {
  const session = row.session
  const folder = nonEmpty(session?.workspaceFolder) ? session.workspaceFolder : session?.cwd
  const keys = [row.name, session?.name, nonEmpty(folder) ? lastPathSegment(folder) : undefined]
  return keys.filter(nonEmpty)
}

/** Whether the row matches the query (see the top of this module). An empty or blank query matches every row. */
export function matchesQuery(row: SearchableRow, query: string): boolean {
  const needle = foldForSearch(query.trim())
  if (needle === '') return true
  return searchKeys(row).some((key) => foldForSearch(key).includes(needle))
}

/** The rows the query finds, in their order. */
export function filterRows<R extends SearchableRow>(rows: readonly R[], query: string): R[] {
  return rows.filter((row) => matchesQuery(row, query))
}
