import { describe, expect, it } from 'vitest'
import { createPerfCounters, formatPerfLine, type JobTotals, type PerfClock } from './perf-log.js'

const none: JobTotals = { runs: 0, ms: 0, chars: 0 }

describe('formatPerfLine', () => {
  it('writes the period, the CPU, the event loop and every job as key=value fields', () => {
    const line = formatPerfLine({
      wallMs: 600_000,
      cpu: { user: 3_900_000, system: 580_000 },
      loopBusy: 0.0123,
      jobs: {
        scan: { runs: 200, ms: 1234.56, chars: 0 },
        broadcast: { runs: 4, ms: 2.5, chars: 1002 },
        tray: { runs: 600, ms: 120, chars: 0 },
        notifier: { runs: 600, ms: 30.04, chars: 0 },
        seen: none,
      },
    })
    expect(line).toBe(
      '[perf] period=600.0s cpu=4.480s user=3.900s system=0.580s core=0.75% loop=1.23% ' +
        'scan=200/1234.6ms broadcast=4/2.5ms/251ch tray=600/120.0ms notifier=600/30.0ms seen=0/0.0ms',
    )
  })

  it('gives zero shares for an empty period and no broadcast', () => {
    const line = formatPerfLine({
      wallMs: 0,
      cpu: { user: 0, system: 0 },
      loopBusy: 0,
      jobs: { scan: none, broadcast: none, tray: none, notifier: none, seen: none },
    })
    expect(line).toContain('core=0.00%')
    expect(line).toContain('broadcast=0/0.0ms/0ch')
  })
})

/** A clock the test moves by hand. */
function manualClock(): PerfClock & { at: { now: number; user: number; system: number; idle: number; active: number } } {
  const at = { now: 0, user: 0, system: 0, idle: 0, active: 0 }
  return {
    at,
    now: () => at.now,
    cpuUsage: () => ({ user: at.user, system: at.system }),
    eventLoop: () => ({ idle: at.idle, active: at.active, utilization: 0 }),
  }
}

describe('createPerfCounters', () => {
  it('sums the runs of each job and reports the deltas since the last flush', () => {
    const clock = manualClock()
    const counters = createPerfCounters(clock)
    counters.add('scan', 10)
    counters.add('scan', 5)
    counters.add('broadcast', 1, 300)
    Object.assign(clock.at, { now: 1000, user: 30_000, system: 10_000, idle: 900, active: 100 })
    expect(counters.flush()).toBe(
      '[perf] period=1.0s cpu=0.040s user=0.030s system=0.010s core=4.00% loop=10.00% ' +
        'scan=2/15.0ms broadcast=1/1.0ms/300ch tray=0/0.0ms notifier=0/0.0ms seen=0/0.0ms',
    )
  })

  it('starts every period from zero', () => {
    const clock = manualClock()
    const counters = createPerfCounters(clock)
    counters.add('tray', 3)
    Object.assign(clock.at, { now: 1000, user: 10_000, idle: 500, active: 500 })
    counters.flush()
    counters.add('seen', 2)
    Object.assign(clock.at, { now: 3000, user: 30_000, idle: 2000, active: 1000 })
    expect(counters.flush()).toBe(
      '[perf] period=2.0s cpu=0.020s user=0.020s system=0.000s core=1.00% loop=25.00% ' +
        'scan=0/0.0ms broadcast=0/0.0ms/0ch tray=0/0.0ms notifier=0/0.0ms seen=1/2.0ms',
    )
  })
})
