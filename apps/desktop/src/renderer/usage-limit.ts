import type { SessionStatus, UsageLimit } from '@claudeswitcher/core'
import { isRecord, USAGE_LIMIT_KIND } from '@claudeswitcher/core/browser'

/**
 * The Hungarian weekday names, keyed by the `en-US` short weekday `Intl.DateTimeFormat` gives. The
 * names come from this table, not from the `hu` locale, so the text does not depend on which locale
 * data the runtime carries.
 */
const WEEKDAYS: Readonly<Record<string, string>> = {
  Mon: 'hétfő',
  Tue: 'kedd',
  Wed: 'szerda',
  Thu: 'csütörtök',
  Fri: 'péntek',
  Sat: 'szombat',
  Sun: 'vasárnap',
}

interface Clock {
  /** `H:mm`, the Hungarian way: the hour without a leading zero (`1:05`, `22:20`). */
  time: string
  weekday: string
  /** The calendar day (`YYYY-MM-DD`), to tell whether two times fall on the same day. */
  day: string
}

/**
 * The wall clock of a moment. `timeZone` is for the tests (an IANA name); the app leaves it out, so
 * the machine's own zone applies.
 */
function clockOf(at: number, timeZone: string | undefined): Clock {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = part('weekday')
  return {
    time: `${String(Number(part('hour')))}:${part('minute')}`,
    weekday: WEEKDAYS[weekday] ?? weekday,
    day: `${part('year')}-${part('month')}-${part('day')}`,
  }
}

/** A reset time of the generic limit: the time alone on the same day, else with the weekday. */
function laterTime(at: number, now: number, timeZone: string | undefined): string {
  const clock = clockOf(at, timeZone)
  return clock.day === clockOf(now, timeZone).day ? clock.time : `${clock.weekday} ${clock.time}`
}

/** The limits the texts tell apart; any other `rateLimitType`, or none, is `other`. */
type LimitKind = 'fiveHour' | 'sevenDay' | 'other'

function limitKind(kind: string | undefined): LimitKind {
  if (kind === USAGE_LIMIT_KIND.fiveHour) return 'fiveHour'
  if (kind === USAGE_LIMIT_KIND.sevenDay) return 'sevenDay'
  return 'other'
}

/**
 * The usage limit of a session's activity, checked: the daemon's message is not validated field by
 * field (`state-message.ts` `sanitizeState`), so a malformed value is dropped here instead of
 * reaching the row text. A `kind` that is not a string, or a `resetsAt` that is not a finite
 * number, is left out; the limit itself stays.
 */
function readUsageLimit(value: unknown): UsageLimit | undefined {
  if (!isRecord(value)) return undefined
  const kind = value['kind']
  const resetsAt = value['resetsAt']
  return {
    kind: typeof kind === 'string' ? kind : undefined,
    resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : undefined,
  }
}

/**
 * The usage limit the session's row shows, the one rule of it: the transcript's limit record
 * (`SessionActivity.usageLimit`), while the session is idle. The core clears the limit at the next
 * prompt or answer in the transcript; a session that works or waits again (a hook, the registry)
 * before the transcript shows it does not count as stopped by the limit.
 */
export function sessionUsageLimit(view: {
  status: SessionStatus
  activity?: { usageLimit?: unknown } | undefined
}): UsageLimit | undefined {
  return view.status === 'idle' ? readUsageLimit(view.activity?.usageLimit) : undefined
}

/**
 * The row's text of a usage limit: which limit, and when it resets, in the machine's local time.
 * Once `resetsAt` has passed, that the session can go on. Without `resetsAt` the sentence has no
 * reset part. An unknown kind gets the generic sentence, never a guess.
 */
export function usageLimitRowText(limit: UsageLimit, now: number, timeZone?: string): string {
  const { kind, resetsAt } = limit
  if (resetsAt !== undefined && resetsAt <= now) return 'A limit lejárt, folytathatod.'
  switch (limitKind(kind)) {
    case 'fiveHour':
      return resetsAt === undefined
        ? 'Elérte az 5 órás limitet.'
        : `Elérte az 5 órás limitet, ${clockOf(resetsAt, timeZone).time}-kor folytathatod.`
    case 'sevenDay': {
      if (resetsAt === undefined) return 'Elérte a heti limitet.'
      const clock = clockOf(resetsAt, timeZone)
      return `Elérte a heti limitet, ${clock.weekday} ${clock.time}-kor folytathatod.`
    }
    case 'other':
      return resetsAt === undefined
        ? 'Elérte a használati limitet.'
        : `Elérte a használati limitet, ${laterTime(resetsAt, now, timeZone)}-kor folytathatod.`
  }
}

/**
 * The status bar's note of the account's usage limit, or `undefined` when no session reports one
 * that is still running. Among several, the one that resets last: until then the account cannot
 * work, whichever limit resets first. A limit without `resetsAt` is left out: its end is unknown,
 * so the bar could not say until when, and it would never go away.
 */
export function usageLimitStatusText(
  sessions: readonly { status: SessionStatus; activity?: { usageLimit?: unknown } | undefined }[],
  now: number,
  timeZone?: string,
): string | undefined {
  let latest: { kind?: string | undefined; resetsAt: number } | undefined
  for (const session of sessions) {
    const limit = sessionUsageLimit(session)
    const resetsAt = limit?.resetsAt
    if (resetsAt === undefined || resetsAt <= now) continue
    if (latest === undefined || resetsAt > latest.resetsAt) latest = { kind: limit?.kind, resetsAt }
  }
  if (latest === undefined) return undefined
  const clock = clockOf(latest.resetsAt, timeZone)
  switch (limitKind(latest.kind)) {
    case 'fiveHour':
      return `5 órás limit ${clock.time}-ig`
    case 'sevenDay':
      return `heti limit ${clock.weekday} ${clock.time}-ig`
    case 'other':
      return `használati limit ${laterTime(latest.resetsAt, now, timeZone)}-ig`
  }
}
