import { isRecord } from '@claudeswitcher/core/browser'

/**
 * The shape of the excluded sessions: how `config.json` stores them (main `config.ts`
 * `StoredConfig.excludedSessions`, `dueSessions` and `weeklyReset`) and how the IPC reply carries
 * them (`OVERLAY_CHANNELS.excludedSessions`, `setExcluded`, `setExcludedUntil`, `clearDue`,
 * `excludedChanged`). The main process keeps them (`main/excluded-sessions.ts`), the overlay reads
 * them with a check (`renderer/useExcludedSessions.ts`). Compiled by both the main and the renderer
 * projects, so it imports no `node:` module.
 */

/** One excluded session. */
export interface ExcludedEntry {
  sessionId: string
  /**
   * Excluded while its turn was in progress (its status was not `idle`): it stays out when it runs
   * again. Otherwise it comes back into the list once it starts running.
   */
  whileRunning: boolean
  /**
   * Excluded until this time (epoch ms, Shift+Delete): at the time it comes back into the list with
   * the due mark (`DueEntry`). Absent: excluded without a time (Delete), as before the field existed.
   */
  until?: number
}

/** A session whose exclusion time has passed: back in the list, marked, until the user first opens it. */
export interface DueEntry {
  sessionId: string
  /** The time it was excluded until (`ExcludedEntry.until`), which the mark's tooltip names. */
  until: number
}

/**
 * When the account's weekly usage limit resets, as the owner writes it into `config.json` by hand
 * (`weeklyReset`): the weekday (1 Monday … 7 Sunday; 0 is Sunday too, as `Date.getDay` counts) and
 * the local time. Read by `readWeeklyReset`.
 */
export interface WeeklyReset {
  /** 0 Sunday, 1 Monday … 6 Saturday, as `Date.getDay` gives it (a stored 7 reads as 0). */
  weekday: number
  hour: number
  minute: number
}

/** The reply of `excludedSessions`, `setExcluded`, `setExcludedUntil` and `clearDue`, and the payload of `excludedChanged`. */
export interface ExcludedReply {
  /** The excluded sessions, in the order they were excluded. */
  excluded: ExcludedEntry[]
  /** The sessions that came back because they started running, until the first jump to each. */
  returned: string[]
  /** The sessions whose exclusion time has passed, until the first jump to each or a Backspace on its row. */
  due: DueEntry[]
  /** The weekly reset from `config.json`, when it is set there. */
  weeklyReset?: WeeklyReset
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The items of an array that `read` accepts, each session once, the first one kept; a non-array gives none. */
function readUnique<T extends { sessionId: string }>(value: unknown, read: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return []
  const entries = new Map<string, T>()
  for (const item of value as unknown[]) {
    const entry = read(item)
    if (entry !== undefined && !entries.has(entry.sessionId)) entries.set(entry.sessionId, entry)
  }
  return [...entries.values()]
}

/**
 * The excluded sessions from a stored or received value: the items of an array that are an entry
 * (a non-empty `sessionId`, a boolean `whileRunning`, and an `until` that is absent or a finite
 * number), each session once, the first one kept. A plain non-empty string is an older file's
 * item, and reads as `whileRunning: false` without a time; so does an entry of v0.26.0, which has
 * no `until`. An item whose `until` is there but not a finite number drops out: a misread time
 * must not hide a session for good. Never throws: anything else drops out too, and a value that is
 * not an array gives none.
 */
export function readExcludedEntries(value: unknown): ExcludedEntry[] {
  return readUnique(value, (item) => (nonEmptyString(item) ? { sessionId: item, whileRunning: false } : readEntry(item)))
}

function readEntry(item: unknown): ExcludedEntry | undefined {
  if (!isRecord(item)) return undefined
  const sessionId = item['sessionId']
  const whileRunning = item['whileRunning']
  const until = item['until']
  if (!nonEmptyString(sessionId) || typeof whileRunning !== 'boolean') return undefined
  if (until === undefined) return { sessionId, whileRunning }
  return finiteNumber(until) ? { sessionId, whileRunning, until } : undefined
}

/** The due marks from a stored or received value: the items with a non-empty `sessionId` and a finite `until`, each session once. */
export function readDueEntries(value: unknown): DueEntry[] {
  return readUnique(value, (item) => {
    if (!isRecord(item)) return undefined
    const sessionId = item['sessionId']
    const until = item['until']
    return nonEmptyString(sessionId) && finiteNumber(until) ? { sessionId, until } : undefined
  })
}

/** `HH:MM` or `H:MM`, 0:00 to 23:59. */
const RESET_TIME = /^(\d{1,2}):(\d{2})$/

/**
 * The weekly reset from `config.json` (`{ "weekday": 4, "time": "07:00" }`) or from the IPC reply
 * (`{ weekday, hour, minute }`), read leniently: anything that is not one of these, with an
 * integer weekday from 0 to 7 and a valid time, counts as not set (`undefined`). Never throws.
 */
export function readWeeklyReset(value: unknown): WeeklyReset | undefined {
  if (!isRecord(value)) return undefined
  const weekday = value['weekday']
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 7) return undefined
  const time = value['time']
  let hour: unknown = value['hour']
  let minute: unknown = value['minute']
  if (typeof time === 'string') {
    const match = RESET_TIME.exec(time)
    if (match === null) return undefined
    hour = Number(match[1])
    minute = Number(match[2])
  }
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return undefined
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
  return { weekday: weekday % 7, hour, minute }
}

/** The non-empty strings of an array, each once; anything else gives none. */
export function readSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set((value as unknown[]).filter(nonEmptyString))]
}
