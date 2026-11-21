// Usage: pnpm --filter @claudeswitcher/daemon... build && node scripts/measure/scan-cost.mjs [rounds=5] [both|plain|cached]
// Read only. Times the per-session work of one daemon scan (`packages/daemon/src/scanner.ts`
// `scanSessions`) on the real `~/.claude`: for every session record whose process runs,
// `findTranscriptPath`, `readTranscriptActivity`, and the subagent listing (`readSubagents`: a
// `readdir` of the transcript's `subagents` folder and a `stat` of every file in it), with the core's
// built code. Then the same rounds through the daemon's built transcript cache
// (`packages/daemon/src/transcript-cache.ts` `createTranscriptCache`, as `startDaemon` passes it to
// `scanSessions`) and the same subagent listing: the first round fills the cache, the later ones show
// what a scan costs while the transcripts stay unchanged (a transcript written meanwhile is read
// again, as in the daemon). Prints the transcript sizes, the wall times and the CPU time of a round
// (`process.cpuUsage`), never the transcripts' content. The daemon runs a scan every
// `POLL_INTERVAL_MS`, so the CPU time per round, divided by that interval, is the scan's share of a core.
import fs from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  POLL_INTERVAL_MS,
  findTranscriptPath,
  parseSessionRecord,
  readTranscriptActivity,
  sessionsDir,
  subagentsDirOf,
} from '../../packages/core/dist/index.js'
import { createTranscriptCache } from '../../packages/daemon/dist/transcript-cache.js'

const rounds = Number(process.argv[2] ?? '5')
// `plain` or `cached` runs only that half, so neither half's work can spill into the other's CPU time.
const mode = process.argv[3] ?? 'both'
if (!['both', 'plain', 'cached'].includes(mode)) throw new Error(`unknown mode ${mode}: both, plain or cached`)
const claudeDir = path.join(os.homedir(), '.claude')

/** Whether a process runs: signal 0 only checks, it sends nothing. */
function runs(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'
  }
}

const dir = sessionsDir(claudeDir)
const records = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => parseSessionRecord(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))))
  .filter((record) => record !== null && runs(record.pid))

console.log(`${String(records.length)} running sessions; poll every ${String(POLL_INTERVAL_MS)} ms`)

/** The subagent listing as `readSubagents` does it: every file of the folder, `stat`ed at once. */
async function listSubagents(/** @type {string} */ transcript) {
  const folder = subagentsDirOf(transcript)
  const names = await readdir(folder).catch(() => [])
  await Promise.all(names.map((name) => stat(path.join(folder, name)).catch(() => undefined)))
  return names.length
}

const median = (/** @type {number[]} */ values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

const mean = (/** @type {number[]} */ values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

/**
 * One summary line: the means of `wall` and `cpu` (ms) and the CPU's share of a core at one scan per
 * poll. The mean, not the median: the garbage of a round is collected on other threads during later
 * rounds, and `process.cpuUsage` counts every thread, so only the mean over many rounds charges each
 * round its share.
 */
function summary(/** @type {string} */ label, /** @type {number[]} */ wall, /** @type {number[]} */ cpu) {
  const cpuMs = mean(cpu)
  return (
    `${label}: ${mean(wall).toFixed(0)} ms wall, ${cpuMs.toFixed(0)} ms CPU, ` +
    `${((cpuMs / POLL_INTERVAL_MS) * 100).toFixed(1)}% of a core at one scan per ${String(POLL_INTERVAL_MS)} ms`
  )
}

if (mode !== 'cached') {
  /** @type {Map<string, { size: number; files: number; find: number[]; read: number[]; list: number[] }>} */
  const bySession = new Map()
  const totals = []
  const cpuTotals = []
  for (let round = 0; round < rounds; round += 1) {
    let total = 0
    const cpuBefore = process.cpuUsage()
    for (const record of records) {
      if (record === null) continue
      const t0 = performance.now()
      const transcript = await findTranscriptPath(claudeDir, record.sessionId)
      const t1 = performance.now()
      if (transcript !== undefined) await readTranscriptActivity(transcript)
      const t2 = performance.now()
      const files = transcript === undefined ? 0 : await listSubagents(transcript)
      const t3 = performance.now()
      const entry = bySession.get(record.sessionId) ?? {
        size: transcript === undefined ? 0 : fs.statSync(transcript).size,
        files,
        find: [],
        read: [],
        list: [],
      }
      entry.find.push(t1 - t0)
      entry.read.push(t2 - t1)
      entry.list.push(t3 - t2)
      bySession.set(record.sessionId, entry)
      total += t3 - t0
    }
    totals.push(total)
    const cpu = process.cpuUsage(cpuBefore)
    cpuTotals.push((cpu.user + cpu.system) / 1000)
  }

  const rows = [...bySession].sort(([, a], [, b]) => median(b.read) - median(a.read))
  console.log('session   size MB  find ms  read ms  subagents  list ms (medians)')
  for (const [id, entry] of rows) {
    console.log(
      `${id.slice(0, 8)}  ${(entry.size / 2 ** 20).toFixed(1).padStart(7)}  ${median(entry.find).toFixed(1).padStart(7)}  ${median(entry.read).toFixed(1).padStart(7)}  ${String(entry.files).padStart(9)}  ${median(entry.list).toFixed(1).padStart(7)}`,
    )
  }
  console.log(summary(`without the cache, per round (mean of rounds 2..${String(rounds)})`, totals.slice(1), cpuTotals.slice(1)))
}

if (mode !== 'plain') {
  const cache = createTranscriptCache()
  const cachedWall = []
  const cachedCpu = []
  for (let round = 0; round < rounds; round += 1) {
    const cpuBefore = process.cpuUsage()
    const t0 = performance.now()
    for (const record of records) {
      if (record === null) continue
      const reading = await cache.read(claudeDir, record.sessionId)
      if (reading !== undefined) await listSubagents(reading.transcript)
    }
    cachedWall.push(performance.now() - t0)
    const cpu = process.cpuUsage(cpuBefore)
    cachedCpu.push((cpu.user + cpu.system) / 1000)
  }
  console.log(summary('with the cache, round 1 (fills it)', cachedWall.slice(0, 1), cachedCpu.slice(0, 1)))
  console.log(summary(`with the cache, per round (mean of rounds 2..${String(rounds)})`, cachedWall.slice(1), cachedCpu.slice(1)))
}
