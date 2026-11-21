import { performance, type EventLoopUtilization } from 'node:perf_hooks'
import type { DaemonJob } from '@claudeswitcher/daemon'

/** How often the main process logs its `[perf]` line (`index.ts`). */
export const PERF_LOG_INTERVAL_MS = 10 * 60_000

/**
 * The periodic jobs the line counts: the daemon's (`DaemonJob`, through `startDaemon`'s `onTimed`)
 * and the main process's own: the tray tick without its notifier part (`tray`), the notifier part of
 * the same tick (`notifier`), and the seen watch's poll (`seen`), all in `index.ts`.
 */
type PerfJob = DaemonJob | 'tray' | 'notifier' | 'seen'

/** The jobs in the line's order. */
const PERF_JOBS: readonly PerfJob[] = ['scan', 'broadcast', 'tray', 'notifier', 'seen']

/** One job's totals over a period. */
export interface JobTotals {
  runs: number
  /** The summed time of its runs, ms. */
  ms: number
  /** The summed length of what it serialised, UTF-16 code units (only `broadcast` reports one). */
  chars: number
}

/** What the line reports for one period. */
export interface PerfPeriod {
  /** The period's length, ms. */
  wallMs: number
  /** The process's CPU time over the period, µs (`process.cpuUsage`, every thread of the process). */
  cpu: { user: number; system: number }
  /** The share of the period the main thread's event loop was busy, 0 to 1 (`eventLoopUtilization`). */
  loopBusy: number
  jobs: Readonly<Record<PerfJob, JobTotals>>
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3)
const percent = (share: number): string => (share * 100).toFixed(2)

/**
 * The `[perf]` line: `key=value` fields separated by spaces, so a day of lines can be grepped and
 * summed. `period`, `cpu` (`user` + `system`), `user` and `system` in seconds; `core`, the CPU time's
 * share of one core over the period; `loop`, the share the event loop was busy. Then per job
 * `<name>=<runs>/<ms>ms`, and for `broadcast` also the average serialised length (`/<chars>ch`).
 */
export function formatPerfLine(period: PerfPeriod): string {
  const cpuMs = (period.cpu.user + period.cpu.system) / 1000
  const fields = [
    `period=${(period.wallMs / 1000).toFixed(1)}s`,
    `cpu=${seconds(cpuMs)}s`,
    `user=${seconds(period.cpu.user / 1000)}s`,
    `system=${seconds(period.cpu.system / 1000)}s`,
    `core=${period.wallMs > 0 ? percent(cpuMs / period.wallMs) : '0.00'}%`,
    `loop=${percent(period.loopBusy)}%`,
  ]
  for (const job of PERF_JOBS) {
    const { runs, ms, chars } = period.jobs[job]
    const average = job === 'broadcast' ? `/${String(runs > 0 ? Math.round(chars / runs) : 0)}ch` : ''
    fields.push(`${job}=${String(runs)}/${ms.toFixed(1)}ms${average}`)
  }
  return `[perf] ${fields.join(' ')}`
}

/** The clocks the counters read; the defaults are Node's. */
export interface PerfClock {
  now(): number
  cpuUsage(): NodeJS.CpuUsage
  eventLoop(): EventLoopUtilization
}

const nodeClock: PerfClock = {
  now: () => performance.now(),
  cpuUsage: () => process.cpuUsage(),
  eventLoop: () => performance.eventLoopUtilization(),
}

export interface PerfCounters {
  /** Adds one run of `job` that took `ms`, with the length of what it serialised, if any. */
  add: (job: PerfJob, ms: number, chars?: number) => void
  /** The line of the period since the last flush (or the start), and a new period from now. */
  flush: () => string
}

function emptyJobs(): Record<PerfJob, JobTotals> {
  const zero = (): JobTotals => ({ runs: 0, ms: 0, chars: 0 })
  return { scan: zero(), broadcast: zero(), tray: zero(), notifier: zero(), seen: zero() }
}

/** The counters of the `[perf]` line. `add` only adds, so it costs nothing next to the jobs it counts. */
export function createPerfCounters(clock: PerfClock = nodeClock): PerfCounters {
  let jobs = emptyJobs()
  let startedAt = clock.now()
  let cpuAtStart = clock.cpuUsage()
  let loopAtStart = clock.eventLoop()

  return {
    add(job, ms, chars = 0) {
      const totals = jobs[job]
      totals.runs += 1
      totals.ms += ms
      totals.chars += chars
    },
    flush() {
      const now = clock.now()
      const cpu = clock.cpuUsage()
      const loop = clock.eventLoop()
      const active = loop.active - loopAtStart.active
      const total = active + (loop.idle - loopAtStart.idle)
      const line = formatPerfLine({
        wallMs: now - startedAt,
        cpu: { user: cpu.user - cpuAtStart.user, system: cpu.system - cpuAtStart.system },
        loopBusy: total > 0 ? active / total : 0,
        jobs,
      })
      jobs = emptyJobs()
      startedAt = now
      cpuAtStart = cpu
      loopAtStart = loop
      return line
    },
  }
}
