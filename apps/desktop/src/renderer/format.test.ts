import { describe, expect, it } from 'vitest'
import { formatDuration, formatResetsIn, summarize } from './format.js'

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45mp')
  })

  it('renders minutes and seconds', () => {
    expect(formatDuration(134_000)).toBe('2:14')
  })

  it('renders hours', () => {
    expect(formatDuration(3_700_000)).toBe('1:01:40')
  })

  it('clamps a negative duration to zero', () => {
    expect(formatDuration(-5)).toBe('0mp')
  })
})

describe('formatResetsIn', () => {
  it('renders hours until reset', () => {
    const now = 1_000_000_000_000
    expect(formatResetsIn(now / 1000 + 7200, now)).toBe('2h múlva')
  })

  it('renders minutes when under an hour', () => {
    const now = 1_000_000_000_000
    expect(formatResetsIn(now / 1000 + 600, now)).toBe('10p múlva')
  })
})

describe('summarize', () => {
  it('prefers the notification text when waiting', () => {
    const line = summarize({
      status: 'waiting',
      notificationText: 'Claude needs permission to run pnpm test',
      activity: { runningTool: 'Bash' },
    })
    expect(line).toBe('Claude needs permission to run pnpm test')
  })

  it('names the running tool when working', () => {
    expect(summarize({ status: 'working', activity: { runningTool: 'Bash' } })).toBe('Bash fut')
  })

  it('shows the last assistant text when idle', () => {
    expect(summarize({ status: 'idle', activity: { lastAssistantText: 'Kész.' } })).toBe('Kész.')
  })

  it('truncates a long summary', () => {
    const long = 'x'.repeat(200)
    expect(summarize({ status: 'idle', activity: { lastAssistantText: long } }).length).toBe(80)
  })

  it('falls back when there is nothing to say', () => {
    expect(summarize({ status: 'idle', activity: {} })).toBe('—')
  })

  it('survives a session whose activity is missing entirely', () => {
    // A daemon a típus szerint mindig ad `activity`-t, de egy hibás üzenet nem. Ez
    // renderelés közben dobna, és az egész overlay eltűnne.
    const broken = { status: 'idle' } as unknown as Parameters<typeof summarize>[0]
    expect(() => summarize(broken)).not.toThrow()
    expect(summarize(broken)).toBe('—')
  })
})
