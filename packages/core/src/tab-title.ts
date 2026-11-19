/**
 * The two transcript records that name a session's tab in the VS Code extension, the one home of
 * their type and field names. Measured on 2.1.325 (2026-11-19, design doc "The window title and the
 * tab title"): `{"type":"custom-title","customTitle":…}` after the user renamed the session, and
 * `{"type":"ai-title","aiTitle":…}` otherwise. Both are written again at the end of every turn, so a
 * finished session has them near the end of its transcript. The tab shows the custom title whenever
 * there is one, even when `ai-title` records come after it.
 */
const TITLE_RECORD = {
  custom: { type: 'custom-title', field: 'customTitle' },
  ai: { type: 'ai-title', field: 'aiTitle' },
} as const

/** Which record a title came from. */
type TitleSource = keyof typeof TITLE_RECORD

/** The latest title of each kind seen so far in the transcript. */
export type TitlesSeen = Partial<Record<TitleSource, string>>

/**
 * The title a transcript record carries, or `undefined` when the record is not a title record (see
 * `TITLE_RECORD`) or its title is not a string with something other than whitespace in it.
 */
export function titleRecordOf(rec: Record<string, unknown>): { source: TitleSource; title: string } | undefined {
  for (const source of ['custom', 'ai'] as const) {
    const { type, field } = TITLE_RECORD[source]
    if (rec['type'] !== type) continue
    const title = rec[field]
    return typeof title === 'string' && title.trim() !== '' ? { source, title } : undefined
  }
  return undefined
}

/** The title the tab shows: the custom title wins over the AI title, whichever came later. */
export function shownTabTitle(titles: TitlesSeen): string | undefined {
  return titles.custom ?? titles.ai
}
