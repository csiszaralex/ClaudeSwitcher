import { useShownValue } from './useShownValue.js'

/**
 * The excluded session ids from the IPC reply (`OVERLAY_CHANNELS.excludedSessions`, `setExcluded`):
 * an array of session ids. Never throws: an item that is not a non-empty string drops out, anything
 * else gives an empty set, so the worst case is an excluded session shown in the list.
 */
export function readExcludedSessions(raw: unknown): ReadonlySet<string> {
  if (!Array.isArray(raw)) return new Set()
  return new Set((raw as unknown[]).filter((id): id is string => typeof id === 'string' && id !== ''))
}

const NONE_EXCLUDED: ReadonlySet<string> = new Set()

function fetchExcludedSessions(): Promise<unknown> {
  return window.claudeswitcher.excludedSessions()
}

/**
 * The sessions the user moved out of the list, as the main process keeps them
 * (`main/excluded-sessions.ts`). Read when the page loads and on every `shown`; the reply of a
 * Delete (`setExcluded`) answers with the whole list, which App passes to the returned function, so
 * the row moves at once. The main process also drops the ids of gone sessions, between two `shown`s;
 * such an id has no row meanwhile anyway.
 */
export function useExcludedSessions(): [
  ReadonlySet<string>,
  (reply: Promise<unknown>, onApplied?: (excluded: ReadonlySet<string>) => void) => void,
] {
  return useShownValue(fetchExcludedSessions, readExcludedSessions, NONE_EXCLUDED, 'the excluded sessions')
}
