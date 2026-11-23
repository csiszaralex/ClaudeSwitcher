import { isRecord } from '@claudeswitcher/core/browser'

/**
 * The shape of the excluded sessions: how `config.json` stores them (main `config.ts`
 * `StoredConfig.excludedSessions`) and how the IPC reply carries them (`OVERLAY_CHANNELS.excludedSessions`,
 * `setExcluded`, `excludedChanged`). The main process keeps them (`main/excluded-sessions.ts`), the
 * overlay reads them with a check (`renderer/useExcludedSessions.ts`). Compiled by both the main and
 * the renderer projects, so it imports no `node:` module.
 */

/** One excluded session. */
export interface ExcludedEntry {
  sessionId: string
  /**
   * Excluded while its turn was in progress (its status was not `idle`): it stays out when it runs
   * again. Otherwise it comes back into the list once it starts running.
   */
  whileRunning: boolean
}

/** The reply of `excludedSessions` and `setExcluded`, and the payload of `excludedChanged`. */
export interface ExcludedReply {
  /** The excluded sessions, in the order they were excluded. */
  excluded: ExcludedEntry[]
  /** The sessions that came back because they started running, until the first jump to each. */
  returned: string[]
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * The excluded sessions from a stored or received value: the items of an array that are an entry
 * (a non-empty `sessionId` and a boolean `whileRunning`), each session once, the first one kept. A
 * plain non-empty string is an older file's item, and reads as `whileRunning: false`. Never throws:
 * anything else drops out, and a value that is not an array gives none.
 */
export function readExcludedEntries(value: unknown): ExcludedEntry[] {
  if (!Array.isArray(value)) return []
  const entries = new Map<string, ExcludedEntry>()
  for (const item of value as unknown[]) {
    const entry = nonEmptyString(item) ? { sessionId: item, whileRunning: false } : readEntry(item)
    if (entry !== undefined && !entries.has(entry.sessionId)) entries.set(entry.sessionId, entry)
  }
  return [...entries.values()]
}

function readEntry(item: unknown): ExcludedEntry | undefined {
  if (!isRecord(item)) return undefined
  const sessionId = item['sessionId']
  const whileRunning = item['whileRunning']
  return nonEmptyString(sessionId) && typeof whileRunning === 'boolean' ? { sessionId, whileRunning } : undefined
}

/** The non-empty strings of an array, each once; anything else gives none. */
export function readSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set((value as unknown[]).filter(nonEmptyString))]
}
