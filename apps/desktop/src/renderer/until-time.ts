import type { WeeklyReset } from '../shared/excluded-sessions.js'
import { WEEKDAY_NAMES } from '../shared/hungarian-text.js'
import { foldForSearch } from './session-search.js'

/**
 * The times of a timed exclusion (Shift+Delete on a row, the bar under it, `UntilBar.tsx`): the
 * Hungarian time phrases the bar's field takes (`parseUntil`, pure, no AI), the bar's presets
 * (`untilPresets`), the next weekly reset (`nextWeeklyReset`), and how a time reads in the bar's
 * preview and in the row's tags (`untilClock`). Every time is the machine's local time, computed with
 * the `Date` setters, so a change of the clocks (DST) is the platform's.
 */

/** The bar's texts. */
export const UNTIL_TEXT = {
  oneHour: '1 óra',
  tomorrowMorning: 'holnap reggel',
  mondayMorning: 'hétfő reggel',
  /** The preset of the weekly reset, while `config.json` has one (`weeklyReset`). */
  weeklyReset: 'heti limit resetig',
  /** The preset of the session's own usage limit, while its reset time is ahead. */
  limitReset: 'limit resetig',
  placeholder: 'Mikorig? Például: 2 óra, holnap 9, csütörtök reggel',
  fieldLabel: 'Mikorig zárod ki a sessiont',
  /** The preview of a text the parser does not take: Enter does nothing then. */
  unknown: 'Nem értem',
  /** The preview of a text that names a time already gone (`ma reggel` at noon): Enter does nothing then. */
  past: 'Ez az időpont már elmúlt',
  /** The preview of a resolved time. */
  preview: (until: number, now: number): string => `${untilClock(until, now)}-ig`,
  keys: 'Enter: kizárás · Tab: a gombok · Esc: mégse',
} as const

/** The parts of the day and their time. */
const PARTS: Readonly<Record<string, readonly [number, number]>> = {
  reggel: [8, 0],
  delelott: [11, 0],
  del: [12, 0],
  delutan: [17, 0],
  este: [20, 0],
}

/** The time a day named alone means: its morning. */
const MORNING = PARTS['reggel'] ?? [8, 0]

/** The days named relative to today, by how many days ahead. */
const RELATIVE_DAYS: Readonly<Record<string, number>> = { ma: 0, holnap: 1, holnaputan: 2 }

/** The weekday names as the parser compares them (folded, `foldForSearch`), to their `Date.getDay` number. */
const WEEKDAYS: ReadonlyMap<string, number> = new Map(WEEKDAY_NAMES.map((name, day) => [foldForSearch(name), day]))

/** The units of a duration, in minutes; `nap` is a calendar day (`addDays`), not 1440 minutes. */
const MINUTES_OF_UNIT: Readonly<Record<string, number>> = { perc: 1, ora: 60 }

/** The time forms: `9`, `9:30`, `09:30`, and `14h`. */
const CLOCK = /^(\d{1,2})(?::(\d{2}))?$/
const CLOCK_H = /^(\d{1,2})h$/

/** What the bar's field reads: a time, a time already gone, or nothing it understands. */
export type UntilParse = { kind: 'time'; until: number } | { kind: 'past' } | { kind: 'unknown' }

const UNKNOWN: UntilParse = { kind: 'unknown' }

/** `now`'s day plus `days` (calendar days) at `hour:minute`, local time. */
function atDay(now: number, days: number, hour: number, minute: number): number {
  const date = new Date(now)
  date.setDate(date.getDate() + days)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

/** `now` plus `days` calendar days, at the same clock time. */
function addDays(now: number, days: number): number {
  const date = new Date(now)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** The time a part of the day or a time form in one word means, as `[hour, minute]`, or `undefined`. */
function clockOf(word: string): readonly [number, number] | undefined {
  const part = PARTS[word]
  if (part !== undefined) return part
  const match = CLOCK.exec(word) ?? CLOCK_H.exec(word)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  return hour <= 23 && minute <= 59 ? [hour, minute] : undefined
}

/** A positive whole number of the duration's amount, or `undefined`. */
function amountOf(word: string): number | undefined {
  if (!/^\d+$/.test(word)) return undefined
  const amount = Number(word)
  return amount >= 1 ? amount : undefined
}

/**
 * A duration from now: `N perc`, `N óra`, `fél óra`, `másfél óra`, `N nap`, each with an optional
 * `múlva` after it. `undefined` when the words are not one.
 */
function durationOf(words: readonly string[], now: number): number | undefined {
  const [amount, unit, after, ...rest] = words
  if (amount === undefined || unit === undefined || rest.length > 0 || (after !== undefined && after !== 'mulva')) return undefined
  if (amount === 'fel' || amount === 'masfel') return unit === 'ora' ? now + (amount === 'fel' ? 30 : 90) * 60_000 : undefined
  const count = amountOf(amount)
  if (count === undefined) return undefined
  if (unit === 'nap') return addDays(now, count)
  const minutes = MINUTES_OF_UNIT[unit]
  return minutes === undefined ? undefined : now + count * minutes * 60_000
}

/** A day and a time of it: `[day] [part or time]`, at least one of the two. `undefined` when the words are not one. */
function dayTimeOf(words: readonly string[], now: number): UntilParse | undefined {
  if (words.length === 0 || words.length > 2) return undefined
  const [first = '', second] = words
  const firstClock = clockOf(first)
  if (words.length === 1 && firstClock !== undefined) {
    // A part or a time alone: today if it is still ahead, else tomorrow.
    const today = atDay(now, 0, firstClock[0], firstClock[1])
    return { kind: 'time', until: today > now ? today : atDay(now, 1, firstClock[0], firstClock[1]) }
  }
  const clock = second === undefined ? MORNING : clockOf(second)
  if (clock === undefined) return undefined
  const [hour, minute] = clock
  const relative = RELATIVE_DAYS[first]
  if (relative !== undefined) {
    const until = atDay(now, relative, hour, minute)
    return until > now ? { kind: 'time', until } : { kind: 'past' }
  }
  const weekday = WEEKDAYS.get(first)
  if (weekday === undefined) return undefined
  // The next such day; today only while the time is still ahead, else a week later.
  const ahead = (weekday - new Date(now).getDay() + 7) % 7
  const until = atDay(now, ahead, hour, minute)
  return { kind: 'time', until: until > now ? until : atDay(now, ahead + 7, hour, minute) }
}

/**
 * The time a phrase of the bar's field means, from `now`, in local time. Accents and case do not
 * matter (`csutortok` is `csütörtök`, `foldForSearch`), and the words are split at any whitespace.
 * It takes:
 * - a duration (`durationOf`): `30 perc`, `2 óra`, `fél óra`, `másfél óra`, `3 nap`, each with an
 *   optional `múlva` (`2 óra múlva`); `N nap` is N calendar days from now, at the same clock time;
 * - a part of the day: `reggel` 08:00, `délelőtt` 11:00, `dél` 12:00, `délután` 17:00, `este` 20:00;
 * - a time: `9`, `9:30`, `09:30`, `14h` (0:00 to 23:59);
 * - a day: `ma`, `holnap`, `holnapután`, or a weekday name (`hétfő` … `vasárnap`), alone (its
 *   morning, 08:00) or followed by a part or a time (`csütörtök reggel`, `holnap 9`);
 * - `limit` alone: the next weekly reset, when `weeklyReset` is set.
 * A part or a time alone is today while it is ahead, else tomorrow. A weekday is its next day; if
 * that is today and the time has passed, a week later. A day named with `ma`, `holnap` or
 * `holnapután` whose time has passed gives `past`. Anything else, an unknown word left over
 * included, gives `unknown`: never a partial guess.
 */
export function parseUntil(text: string, now: number, weeklyReset: WeeklyReset | undefined): UntilParse {
  const words = foldForSearch(text).split(/\s+/).filter((word) => word !== '')
  if (words.length === 1 && words[0] === 'limit') {
    return weeklyReset === undefined ? UNKNOWN : { kind: 'time', until: nextWeeklyReset(weeklyReset, now) }
  }
  const duration = durationOf(words, now)
  const result = duration === undefined ? dayTimeOf(words, now) : { kind: 'time' as const, until: duration }
  // A time outside the range of a `Date` (a duration of a billion days) is no time.
  if (result === undefined || (result.kind === 'time' && Number.isNaN(new Date(result.until).getTime()))) return UNKNOWN
  return result
}

/** The next weekly reset after `now`: this week's, while it is ahead, else next week's. */
export function nextWeeklyReset(reset: WeeklyReset, now: number): number {
  const ahead = (reset.weekday - new Date(now).getDay() + 7) % 7
  const until = atDay(now, ahead, reset.hour, reset.minute)
  return until > now ? until : atDay(now, ahead + 7, reset.hour, reset.minute)
}

/** One preset of the bar: its label and its time. */
export interface UntilPreset {
  label: string
  until: number
}

/**
 * The bar's presets at `now`, in their order: `1 óra`, `holnap reggel`, `hétfő reggel`, then
 * `heti limit resetig` while `config.json` has a weekly reset, and `limit resetig` while the
 * session's usage limit (`limitResetsAt`, renderer `usage-limit.ts` `sessionUsageLimit`) resets in
 * the future. The first one is what Enter takes on an empty field.
 */
export function untilPresets(now: number, weeklyReset: WeeklyReset | undefined, limitResetsAt: number | undefined): UntilPreset[] {
  const presets: UntilPreset[] = []
  for (const label of [UNTIL_TEXT.oneHour, UNTIL_TEXT.tomorrowMorning, UNTIL_TEXT.mondayMorning]) {
    const parsed = parseUntil(label, now, undefined)
    if (parsed.kind === 'time') presets.push({ label, until: parsed.until })
  }
  if (weeklyReset !== undefined) presets.push({ label: UNTIL_TEXT.weeklyReset, until: nextWeeklyReset(weeklyReset, now) })
  if (limitResetsAt !== undefined && limitResetsAt > now) presets.push({ label: UNTIL_TEXT.limitReset, until: limitResetsAt })
  return presets
}

const DAY_MS = 86_400_000

/** The local midnight of the moment's day. */
function midnight(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * How a time reads, seen from `now`, in local time: its day and its `HH:MM`. The day is `ma`,
 * `holnap` or `tegnap`; 2 to 6 days ahead its weekday name; any other day its date
 * (`2026. 12. 03.`), so a time more than six days away never reads as a weekday of this week.
 */
export function untilClock(at: number, now: number): string {
  const date = new Date(at)
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
  // Rounded: a day with a change of the clocks is 23 or 25 hours long.
  const days = Math.round((midnight(at) - midnight(now)) / DAY_MS)
  return `${dayWord(days, date)} ${time}`
}

/** The day of `date`, `days` days from today, as `untilClock` names it. */
function dayWord(days: number, date: Date): string {
  if (days === 0) return 'ma'
  if (days === 1) return 'holnap'
  if (days === -1) return 'tegnap'
  const weekday = days >= 2 && days <= 6 ? WEEKDAY_NAMES[date.getDay()] : undefined
  return weekday ?? `${String(date.getFullYear())}. ${twoDigits(date.getMonth() + 1)}. ${twoDigits(date.getDate())}.`
}
