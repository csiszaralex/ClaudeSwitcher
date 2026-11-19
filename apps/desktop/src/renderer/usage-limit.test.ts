import { describe, expect, it } from 'vitest'
import { sessionUsageLimit, usageLimitRowText, usageLimitStatusText } from './usage-limit.js'

// A fixed zone, so the tests do not depend on the machine's. Every time below is invented.
const ZONE = 'Europe/Budapest'
/** 2026-11-18, a Wednesday, 20:00 in Budapest. */
const NOW = Date.parse('2026-11-18T19:00:00.000Z')
const at = (iso: string): number => Date.parse(iso)

describe('usageLimitRowText', () => {
  it('names the 5-hour limit and the time it resets, with "-kor"', () => {
    const text = (iso: string): string => usageLimitRowText({ kind: 'five_hour', resetsAt: at(iso) }, NOW, ZONE)
    expect(text('2026-11-18T21:20:00.000Z')).toBe('Elérte az 5 órás limitet, 22:20-kor folytathatod.')
    // The hour has no leading zero.
    expect(text('2026-11-19T00:05:00.000Z')).toBe('Elérte az 5 órás limitet, 1:05-kor folytathatod.')
    expect(text('2026-11-19T14:00:00.000Z')).toBe('Elérte az 5 órás limitet, 15:00-kor folytathatod.')
    expect(text('2026-11-19T10:10:00.000Z')).toBe('Elérte az 5 órás limitet, 11:10-kor folytathatod.')
  })

  it('names the weekly limit with the weekday and the time', () => {
    expect(usageLimitRowText({ kind: 'seven_day', resetsAt: at('2026-11-23T07:00:00.000Z') }, NOW, ZONE)).toBe(
      'Elérte a heti limitet, hétfő 8:00-kor folytathatod.',
    )
    expect(usageLimitRowText({ kind: 'seven_day', resetsAt: at('2026-11-22T22:30:00.000Z') }, NOW, ZONE)).toBe(
      'Elérte a heti limitet, vasárnap 23:30-kor folytathatod.',
    )
  })

  it('follows summer time', () => {
    const summerNow = at('2026-06-30T12:00:00.000Z')
    expect(usageLimitRowText({ kind: 'seven_day', resetsAt: at('2026-07-01T06:00:00.000Z') }, summerNow, ZONE)).toBe(
      'Elérte a heti limitet, szerda 8:00-kor folytathatod.',
    )
  })

  it('gives another or a missing kind the generic sentence, with the weekday only on another day', () => {
    const later = at('2026-11-18T21:20:00.000Z')
    const tomorrow = at('2026-11-19T10:10:00.000Z')
    expect(usageLimitRowText({ kind: 'opus_weekly', resetsAt: later }, NOW, ZONE)).toBe(
      'Elérte a használati limitet, 22:20-kor folytathatod.',
    )
    expect(usageLimitRowText({ resetsAt: tomorrow }, NOW, ZONE)).toBe(
      'Elérte a használati limitet, csütörtök 11:10-kor folytathatod.',
    )
  })

  it('leaves the reset part out without a reset time', () => {
    expect(usageLimitRowText({ kind: 'five_hour' }, NOW, ZONE)).toBe('Elérte az 5 órás limitet.')
    expect(usageLimitRowText({ kind: 'seven_day' }, NOW, ZONE)).toBe('Elérte a heti limitet.')
    expect(usageLimitRowText({ kind: 'opus_weekly' }, NOW, ZONE)).toBe('Elérte a használati limitet.')
    expect(usageLimitRowText({}, NOW, ZONE)).toBe('Elérte a használati limitet.')
  })

  it('says the limit is over once the reset time has passed', () => {
    for (const kind of ['five_hour', 'seven_day', 'opus_weekly', undefined]) {
      expect(usageLimitRowText({ kind, resetsAt: NOW }, NOW, ZONE)).toBe('A limit lejárt, folytathatod.')
      expect(usageLimitRowText({ kind, resetsAt: NOW - 60_000 }, NOW, ZONE)).toBe('A limit lejárt, folytathatod.')
    }
  })

  it('formats in the zone it is given', () => {
    const limit = { kind: 'five_hour', resetsAt: at('2026-11-18T21:20:00.000Z') }
    expect(usageLimitRowText(limit, NOW, 'UTC')).toBe('Elérte az 5 órás limitet, 21:20-kor folytathatod.')
  })
})

describe('sessionUsageLimit', () => {
  const usageLimit = { kind: 'five_hour', resetsAt: 1 }

  it('reads the limit of an idle session', () => {
    expect(sessionUsageLimit({ status: 'idle', activity: { usageLimit } })).toEqual(usageLimit)
  })

  it('ignores it while the session works or waits again', () => {
    expect(sessionUsageLimit({ status: 'working', activity: { usageLimit } })).toBeUndefined()
    expect(sessionUsageLimit({ status: 'waiting', activity: { usageLimit } })).toBeUndefined()
  })

  it('survives a missing or malformed value', () => {
    expect(sessionUsageLimit({ status: 'idle' })).toBeUndefined()
    expect(sessionUsageLimit({ status: 'idle', activity: {} })).toBeUndefined()
    expect(sessionUsageLimit({ status: 'idle', activity: { usageLimit: 'five_hour' } })).toBeUndefined()
    expect(sessionUsageLimit({ status: 'idle', activity: { usageLimit: null } })).toBeUndefined()
    expect(sessionUsageLimit({ status: 'idle', activity: { usageLimit: { kind: 5, resetsAt: 'soon' } } })).toEqual({
      kind: undefined,
      resetsAt: undefined,
    })
    expect(sessionUsageLimit({ status: 'idle', activity: { usageLimit: { resetsAt: Number.NaN } } })?.resetsAt).toBeUndefined()
  })
})

describe('usageLimitStatusText', () => {
  const session = (usageLimit: unknown, status: 'idle' | 'working' = 'idle'): { status: 'idle' | 'working'; activity: { usageLimit: unknown } } => ({
    status,
    activity: { usageLimit },
  })

  it('names the limit and until when it lasts, with "-ig"', () => {
    expect(usageLimitStatusText([session({ kind: 'five_hour', resetsAt: at('2026-11-18T21:20:00.000Z') })], NOW, ZONE)).toBe(
      '5 órás limit 22:20-ig',
    )
    expect(usageLimitStatusText([session({ kind: 'seven_day', resetsAt: at('2026-11-23T07:00:00.000Z') })], NOW, ZONE)).toBe(
      'heti limit hétfő 8:00-ig',
    )
    expect(usageLimitStatusText([session({ kind: 'opus_weekly', resetsAt: at('2026-11-19T00:05:00.000Z') })], NOW, ZONE)).toBe(
      'használati limit csütörtök 1:05-ig',
    )
    expect(usageLimitStatusText([session({ resetsAt: at('2026-11-18T21:20:00.000Z') })], NOW, ZONE)).toBe(
      'használati limit 22:20-ig',
    )
  })

  it('shows the limit that resets last', () => {
    const sessions = [
      session({ kind: 'five_hour', resetsAt: at('2026-11-18T21:20:00.000Z') }),
      session({ kind: 'seven_day', resetsAt: at('2026-11-23T07:00:00.000Z') }),
      session({ kind: 'five_hour', resetsAt: at('2026-11-18T20:00:00.000Z') }),
    ]
    expect(usageLimitStatusText(sessions, NOW, ZONE)).toBe('heti limit hétfő 8:00-ig')
  })

  it('shows nothing without a running limit', () => {
    expect(usageLimitStatusText([], NOW, ZONE)).toBeUndefined()
    expect(usageLimitStatusText([session(undefined)], NOW, ZONE)).toBeUndefined()
    // Expired, without a reset time, or of a session that works again.
    expect(usageLimitStatusText([session({ kind: 'five_hour', resetsAt: NOW })], NOW, ZONE)).toBeUndefined()
    expect(usageLimitStatusText([session({ kind: 'five_hour' })], NOW, ZONE)).toBeUndefined()
    expect(
      usageLimitStatusText([session({ kind: 'five_hour', resetsAt: at('2026-11-18T21:20:00.000Z') }, 'working')], NOW, ZONE),
    ).toBeUndefined()
  })

  it('skips an expired limit beside a running one', () => {
    const sessions = [
      session({ kind: 'seven_day', resetsAt: NOW - 1 }),
      session({ kind: 'five_hour', resetsAt: at('2026-11-18T21:20:00.000Z') }),
    ]
    expect(usageLimitStatusText(sessions, NOW, ZONE)).toBe('5 órás limit 22:20-ig')
  })
})
