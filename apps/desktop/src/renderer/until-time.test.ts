import { describe, expect, it } from 'vitest'
import { nextWeeklyReset, parseUntil, UNTIL_TEXT, untilClock, untilPresets, type UntilParse } from './until-time.js'

/**
 * Every time here is built in local time (`new Date(y, m, d, h, min)`), as the parser computes, so
 * the tests hold in any time zone the machine or CI runs in.
 */
const at = (month: number, day: number, hour: number, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime()

/** Monday, 23 November 2026, 10:00. */
const NOW = at(11, 23, 10)
const MINUTE = 60_000

const time = (until: number): UntilParse => ({ kind: 'time', until })
const UNKNOWN: UntilParse = { kind: 'unknown' }
const PAST: UntilParse = { kind: 'past' }
const parse = (text: string, now = NOW): UntilParse => parseUntil(text, now, undefined)

describe('parseUntil: durations', () => {
  it('reads minutes, hours, half an hour, an hour and a half, and days, with an optional múlva', () => {
    expect(parse('30 perc')).toEqual(time(NOW + 30 * MINUTE))
    expect(parse('1 óra')).toEqual(time(NOW + 60 * MINUTE))
    expect(parse('2 óra múlva')).toEqual(time(NOW + 120 * MINUTE))
    expect(parse('fél óra')).toEqual(time(NOW + 30 * MINUTE))
    expect(parse('másfél óra múlva')).toEqual(time(NOW + 90 * MINUTE))
    expect(parse('3 nap')).toEqual(time(at(11, 26, 10)))
    expect(parse('1 nap múlva')).toEqual(time(at(11, 24, 10)))
    expect(parse('45 perc múlva')).toEqual(time(NOW + 45 * MINUTE))
  })

  it('ignores accents, case and extra whitespace', () => {
    expect(parse('MASFEL ORA')).toEqual(time(NOW + 90 * MINUTE))
    expect(parse('  2   ora   mulva ')).toEqual(time(NOW + 120 * MINUTE))
    expect(parse('Fél Óra')).toEqual(time(NOW + 30 * MINUTE))
  })

  it('has no upper bound, but a time beyond the range of a Date is no time', () => {
    expect(parse('400 nap')).toEqual(time(new Date(2026, 10, 23 + 400, 10).getTime()))
    expect(parse('999999999999 nap')).toEqual(UNKNOWN)
    expect(parse('99999999999999999 perc')).toEqual(UNKNOWN)
  })

  it('takes nothing else, and never a partial guess', () => {
    for (const text of ['0 perc', '0 óra', 'fél perc', 'fél nap', 'másfél nap', '2 hét', '2 óra később', '2,5 óra', '2.5 óra', '-1 óra', '1e3 perc', 'óra', 'múlva', '2 múlva', '2 óra múlva múlva', 'egy óra', '2óra', '30 perccel']) {
      expect(parse(text), text).toEqual(UNKNOWN)
    }
  })
})

describe('parseUntil: parts of the day and times alone', () => {
  it('reads the parts of the day: today while ahead, else tomorrow', () => {
    // At 10:00 the morning has passed.
    expect(parse('reggel')).toEqual(time(at(11, 24, 8)))
    expect(parse('délelőtt')).toEqual(time(at(11, 23, 11)))
    expect(parse('dél')).toEqual(time(at(11, 23, 12)))
    expect(parse('délután')).toEqual(time(at(11, 23, 17)))
    expect(parse('este')).toEqual(time(at(11, 23, 20)))
    expect(parse('delelott')).toEqual(time(at(11, 23, 11)))
    expect(parse('DELUTAN')).toEqual(time(at(11, 23, 17)))
    expect(parse('reggel', at(11, 23, 7, 59))).toEqual(time(at(11, 23, 8)))
    expect(parse('este', at(11, 23, 20))).toEqual(time(at(11, 24, 20)))
  })

  it('reads the time forms: today while ahead, else tomorrow, never the moment itself', () => {
    expect(parse('9')).toEqual(time(at(11, 24, 9)))
    expect(parse('9:30')).toEqual(time(at(11, 24, 9, 30)))
    expect(parse('09:30')).toEqual(time(at(11, 24, 9, 30)))
    expect(parse('10:00')).toEqual(time(at(11, 24, 10)))
    expect(parse('10:01')).toEqual(time(at(11, 23, 10, 1)))
    expect(parse('14h')).toEqual(time(at(11, 23, 14)))
    expect(parse('14H')).toEqual(time(at(11, 23, 14)))
    expect(parse('17:30')).toEqual(time(at(11, 23, 17, 30)))
    expect(parse('0:00')).toEqual(time(at(11, 24, 0)))
    expect(parse('23:59')).toEqual(time(at(11, 23, 23, 59)))
  })

  it('takes no other time form', () => {
    for (const text of ['24', '24:00', '9:60', '9:5', '123', '9.30', '14 h', '14óra', '9:30:00', 'h', ':30', '9 reggel', 'reggel 9']) {
      expect(parse(text), text).toEqual(UNKNOWN)
    }
  })
})

describe('parseUntil: days', () => {
  it('reads ma, holnap and holnapután, alone as their morning, or with a part or a time', () => {
    expect(parse('holnap')).toEqual(time(at(11, 24, 8)))
    expect(parse('holnap 9')).toEqual(time(at(11, 24, 9)))
    expect(parse('holnap reggel')).toEqual(time(at(11, 24, 8)))
    expect(parse('holnapután')).toEqual(time(at(11, 25, 8)))
    expect(parse('holnaputan delutan')).toEqual(time(at(11, 25, 17)))
    expect(parse('ma este')).toEqual(time(at(11, 23, 20)))
    expect(parse('ma 10:30')).toEqual(time(at(11, 23, 10, 30)))
  })

  it('says past for a day of ma whose time has gone, never moving it to another day', () => {
    expect(parse('ma')).toEqual(PAST)
    expect(parse('ma reggel')).toEqual(PAST)
    expect(parse('ma 9')).toEqual(PAST)
    expect(parse('ma 10:00')).toEqual(PAST)
  })

  it('reads a weekday as its next day, alone as its morning, accents off', () => {
    expect(parse('kedd')).toEqual(time(at(11, 24, 8)))
    expect(parse('szerda délután')).toEqual(time(at(11, 25, 17)))
    expect(parse('csütörtök reggel')).toEqual(time(at(11, 26, 8)))
    expect(parse('csutortok reggel')).toEqual(time(at(11, 26, 8)))
    expect(parse('péntek dél')).toEqual(time(at(11, 27, 12)))
    expect(parse('szombat 14h')).toEqual(time(at(11, 28, 14)))
    expect(parse('vasárnap')).toEqual(time(at(11, 29, 8)))
    expect(parse('VASARNAP 9:30')).toEqual(time(at(11, 29, 9, 30)))
  })

  it("reads today's weekday as today while the time is ahead, else a week later", () => {
    // Monday 10:00.
    expect(parse('hétfő este')).toEqual(time(at(11, 23, 20)))
    expect(parse('hétfő')).toEqual(time(at(11, 30, 8)))
    expect(parse('hetfo reggel')).toEqual(time(at(11, 30, 8)))
    expect(parse('hétfő 10:00')).toEqual(time(at(11, 30, 10)))
    // On Thursday at 09:00, Thursday morning is next Thursday.
    expect(parse('csütörtök reggel', at(11, 26, 9))).toEqual(time(at(12, 3, 8)))
    expect(parse('csütörtök reggel', at(11, 26, 7))).toEqual(time(at(11, 26, 8)))
  })

  it('takes no other combination, and nothing with a word left over', () => {
    for (const text of ['holnap reggel 9', 'reggel holnap', 'holnap holnap', 'kedd szerda', 'holnap valamikor', 'csütörtökön reggel', 'jövő hét', 'jövő hétfő', 'hétfő reggel 2 óra', 'tegnap', 'most', '', '   ']) {
      expect(parse(text), text).toEqual(UNKNOWN)
    }
  })
})

describe('parseUntil: limit', () => {
  const THURSDAY_7 = { weekday: 4, hour: 7, minute: 0 }

  it('is the next weekly reset when it is set', () => {
    expect(parseUntil('limit', NOW, THURSDAY_7)).toEqual(time(at(11, 26, 7)))
    expect(parseUntil('LIMIT', NOW, THURSDAY_7)).toEqual(time(at(11, 26, 7)))
  })

  it('does not parse without a weekly reset, nor with other words', () => {
    expect(parseUntil('limit', NOW, undefined)).toEqual(UNKNOWN)
    expect(parseUntil('heti limit', NOW, THURSDAY_7)).toEqual(UNKNOWN)
    expect(parseUntil('limit resetig', NOW, THURSDAY_7)).toEqual(UNKNOWN)
  })
})

describe('parseUntil: the clocks changing', () => {
  it('keeps the wall clock across a change of the clocks, which the platform handles', () => {
    // Saturday, 24 October 2026, 10:00; in Central Europe the clocks go back that night.
    const saturday = at(10, 24, 10)
    const morning = parse('holnap reggel', saturday)
    expect(morning.kind).toBe('time')
    if (morning.kind !== 'time') return
    expect(new Date(morning.until).getDate()).toBe(25)
    expect(new Date(morning.until).getHours()).toBe(8)
    expect(parse('1 nap', saturday)).toEqual(time(at(10, 25, 10)))
  })
})

describe('nextWeeklyReset', () => {
  const THURSDAY_7 = { weekday: 4, hour: 7, minute: 0 }

  it("is this week's reset while it is ahead, else next week's", () => {
    expect(nextWeeklyReset(THURSDAY_7, NOW)).toBe(at(11, 26, 7))
    expect(nextWeeklyReset(THURSDAY_7, at(11, 26, 6, 59))).toBe(at(11, 26, 7))
    expect(nextWeeklyReset(THURSDAY_7, at(11, 26, 7))).toBe(at(12, 3, 7))
    expect(nextWeeklyReset({ weekday: 0, hour: 23, minute: 30 }, NOW)).toBe(at(11, 29, 23, 30))
  })
})

describe('untilPresets', () => {
  it('offers 1 óra, holnap reggel and hétfő reggel, in that order', () => {
    expect(untilPresets(NOW, undefined, undefined)).toEqual([
      { label: UNTIL_TEXT.oneHour, until: NOW + 60 * MINUTE },
      { label: UNTIL_TEXT.tomorrowMorning, until: at(11, 24, 8) },
      { label: UNTIL_TEXT.mondayMorning, until: at(11, 30, 8) },
    ])
  })

  it('adds the weekly reset while it is set, and the usage limit while its reset is ahead', () => {
    const labels = (weekly: Parameters<typeof untilPresets>[1], limit: number | undefined): string[] =>
      untilPresets(NOW, weekly, limit).map((preset) => preset.label)
    const reset = { weekday: 4, hour: 7, minute: 0 }
    expect(labels(reset, undefined).at(-1)).toBe(UNTIL_TEXT.weeklyReset)
    expect(untilPresets(NOW, reset, undefined)[3]?.until).toBe(at(11, 26, 7))
    expect(labels(reset, NOW + MINUTE).slice(3)).toEqual([UNTIL_TEXT.weeklyReset, UNTIL_TEXT.limitReset])
    expect(untilPresets(NOW, undefined, NOW + MINUTE)[3]).toEqual({ label: UNTIL_TEXT.limitReset, until: NOW + MINUTE })
    expect(labels(undefined, NOW)).toHaveLength(3)
    expect(labels(undefined, NOW - MINUTE)).toHaveLength(3)
  })
})

describe('untilClock', () => {
  it('names today, tomorrow and yesterday, the weekday within six days, else the date, with HH:MM', () => {
    expect(untilClock(at(11, 23, 18, 30), NOW)).toBe('ma 18:30')
    expect(untilClock(at(11, 24, 8), NOW)).toBe('holnap 08:00')
    expect(untilClock(at(11, 22, 23, 5), NOW)).toBe('tegnap 23:05')
    expect(untilClock(at(11, 25, 8), NOW)).toBe('szerda 08:00')
    expect(untilClock(at(11, 29, 0, 0), NOW)).toBe('vasárnap 00:00')
    expect(untilClock(at(11, 30, 8), NOW)).toBe('2026. 11. 30. 08:00')
    expect(untilClock(at(11, 21, 8), NOW)).toBe('2026. 11. 21. 08:00')
    expect(UNTIL_TEXT.preview(at(11, 26, 8), NOW)).toBe('csütörtök 08:00-ig')
  })

  it('counts the days by the calendar across a change of the clocks', () => {
    expect(untilClock(at(10, 25, 8), at(10, 24, 23))).toBe('holnap 08:00')
    expect(untilClock(at(10, 26, 0, 30), at(10, 24, 23, 30))).toBe('hétfő 00:30')
  })
})

describe('UNTIL_TEXT', () => {
  it('keeps its texts free of an en or em dash', () => {
    for (const text of Object.values(UNTIL_TEXT)) {
      const shown = typeof text === 'string' ? text : text(NOW, NOW)
      expect(shown).not.toMatch(/[–—]/)
    }
  })
})
