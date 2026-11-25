import { isRecord } from '@claudeswitcher/core/browser'
import { useEffect } from 'react'
import { readDueEntries, readExcludedEntries, readSessionIds, readWeeklyReset } from '../shared/excluded-sessions.js'
import type { ExclusionState } from './list-cleanup.js'
import { useShownValue } from './useShownValue.js'

const NONE_EXCLUDED: ExclusionState = {
  excluded: new Set(),
  whileRunning: new Set(),
  returned: new Set(),
  until: new Map(),
  due: new Map(),
  weeklyReset: undefined,
}

/**
 * The excluded sessions from the IPC reply and the push (`OVERLAY_CHANNELS.excludedSessions`,
 * `setExcluded`, `setExcludedUntil`, `clearDue`, `excludedChanged`): a `shared/excluded-sessions.ts`
 * `ExcludedReply`. Never throws: an item that is not an entry, a due mark or a session id drops out
 * (`readExcludedEntries`, `readDueEntries`, `readSessionIds`), a malformed weekly reset counts as not
 * set (`readWeeklyReset`), and anything that is not such an object gives nothing excluded, so the
 * worst case is an excluded session shown in the list.
 */
export function readExcludedSessions(raw: unknown): ExclusionState {
  if (!isRecord(raw)) return NONE_EXCLUDED
  const entries = readExcludedEntries(raw['excluded'])
  const until = new Map<string, number>()
  for (const entry of entries) if (entry.until !== undefined) until.set(entry.sessionId, entry.until)
  return {
    excluded: new Set(entries.map((entry) => entry.sessionId)),
    whileRunning: new Set(entries.filter((entry) => entry.whileRunning).map((entry) => entry.sessionId)),
    returned: new Set(readSessionIds(raw['returned'])),
    until,
    due: new Map(readDueEntries(raw['due']).map((entry) => [entry.sessionId, entry.until])),
    weeklyReset: readWeeklyReset(raw['weeklyReset']),
  }
}

function fetchExcludedSessions(): Promise<unknown> {
  return window.claudeswitcher.excludedSessions()
}

/**
 * The sessions the user moved out of the list, and the ones that came back because they started
 * running or because their time passed, as the main process keeps them (`main/excluded-sessions.ts`).
 * Read when the page loads and on every `shown`; the reply of a Delete (`setExcluded`), of a time
 * from the bar (`setExcludedUntil`) and of a Backspace on a due row (`clearDue`) answers with the
 * whole value, which App passes to the returned function, so the row moves at once; and every push
 * of the main process (a session that came back, a mark the first jump ended, a session gone) goes
 * through the same reply order (`useShownValue`), as `useAutoAccept`'s.
 */
export function useExcludedSessions(): [
  ExclusionState,
  (reply: Promise<unknown>, onApplied?: (exclusion: ExclusionState) => void) => void,
] {
  const [exclusion, track] = useShownValue(fetchExcludedSessions, readExcludedSessions, NONE_EXCLUDED, 'the excluded sessions')
  useEffect(
    () =>
      window.claudeswitcher.onExcludedChanged((raw) => {
        track(Promise.resolve(raw))
      }),
    [track],
  )
  return [exclusion, track]
}
