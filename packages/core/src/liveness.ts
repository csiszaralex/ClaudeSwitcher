import { execFile } from 'node:child_process'
import { PROBE_TTL_MS } from './timings.js'
import type { IdeLock, LiveSession, SessionRecord } from './types.js'

export interface ProcessProbe {
  /**
   * True when the pid exists AND (when `procStart` is given) the process's start time matches. The
   * pid alone is not enough: Windows reuses pids, and orphaned lock files would make us jump to
   * the wrong window.
   */
  isAlive(pid: number, procStart?: string): boolean
  /**
   * The process's image name (the `Name` column of `Get-Process`), or `undefined` when the pid is
   * not alive. Lock files store no `procStart`, so for them this and `startedAtMs` are the two clues
   * to whether the pid really belongs to the recorded IDE or has been reused since.
   */
  imageName(pid: number): string | undefined
  /**
   * The process's start in epoch ms, or `undefined` when the pid is not alive or its start time
   * cannot be read. For lock files it reveals a pid taken over by a process started after the lock
   * was written (see `lockPredatesProcess`).
   */
  startedAtMs(pid: number): number | undefined
  /**
   * Takes a new snapshot when the previous one is stale. The other methods are synchronous and
   * always answer from the latest snapshot: the query never runs inside them, because the probe
   * lives in the Electron main process, where any blocking call stops the whole app. So the scan
   * calls this once, before it resolves the sessions. Never rejects: on an error the previous
   * snapshot stays in effect.
   */
  refresh(): Promise<void>
}

/** The image names (as `Get-Process` reports them) that mean a VS Code window. */
const VSCODE_IMAGE_NAMES = new Set(['code', 'code - insiders'])

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** True when `child` is `parent` or lies under it. */
function isWithin(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(p + '\\')
}

/**
 * How long AFTER the lock file's last write the process may have started while the lock still
 * counts as its own. The file's timestamp and the process's start time are recorded by two
 * separate mechanisms with different resolutions; a few seconds of slack absorbs that. A reused pid
 * gives a far larger gap: in a measurement on 2026-10-25, 116 of 139 locks were over a week old.
 */
export const LOCK_MTIME_SLACK_MS = 5000

/** The offset in ms between FILETIME (100 ns units since 1601-01-01) and the Unix epoch. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n

/**
 * A decimal FILETIME string (the format of `ProcessSnapshot.startFileTime`) in epoch ms, or
 * `undefined` when it is not all digits. It computes with BigInt, because a FILETIME is larger
 * than a `number` holds exactly.
 */
export function fileTimeToEpochMs(fileTime: string): number | undefined {
  if (!/^\d+$/.test(fileTime)) return undefined
  return Number(BigInt(fileTime) / 10_000n - FILETIME_EPOCH_OFFSET_MS)
}

/**
 * True when the lock file was last written before its pid's current process started (beyond the
 * `LOCK_MTIME_SLACK_MS` slack). Then a process that has exited since left the lock behind, and a
 * later process got its pid. The process of the pid written into a lock was already running when
 * it wrote it, so this is never true for a live lock. False when either time is unknown: a lock is
 * not dropped on a guess.
 */
function lockPredatesProcess(lockMtimeMs: number | undefined, processStartMs: number | undefined): boolean {
  if (lockMtimeMs === undefined || processStartMs === undefined) return false
  return processStartMs > lockMtimeMs + LOCK_MTIME_SLACK_MS
}

/**
 * True when the lock's pid really is the kind of process the lock claims.
 *
 * The dangerous case it guards against: an orphaned lock for the same workspace whose pid has been
 * taken by an unrelated process meanwhile. The pid is alive and the path matches. Two signs give
 * it away:
 * - the time: the process started after the lock's last write (`lockPredatesProcess`). This works
 *   even when another `Code.exe` helper process got the pid, which would pass the image name test;
 * - the image name: not a VS Code process. For an unknown IDE this is not checked: better to match
 *   than to exclude a supported editor on a guess.
 */
function ownsLock(lock: IdeLock, probe: ProcessProbe): boolean {
  const image = probe.imageName(lock.pid)
  if (image === undefined) return false
  if (lockPredatesProcess(lock.mtimeMs, probe.startedAtMs(lock.pid))) return false
  if (lock.ideName === undefined || !/visual studio code/i.test(lock.ideName)) return true
  return VSCODE_IMAGE_NAMES.has(image.toLowerCase())
}

function bestWindow(cwd: string, locks: IdeLock[], probe: ProcessProbe): IdeLock | undefined {
  let best: IdeLock | undefined
  let bestLength = -1

  for (const lock of locks) {
    if (!ownsLock(lock, probe)) continue
    for (const folder of lock.workspaceFolders) {
      if (!isWithin(cwd, folder)) continue
      const length = normalize(folder).length
      if (length > bestLength) {
        best = lock
        bestLength = length
      }
    }
  }
  return best
}

export function resolveLiveSessions(
  records: SessionRecord[],
  locks: IdeLock[],
  probe: ProcessProbe,
): LiveSession[] {
  return records
    .filter((r) => probe.isAlive(r.pid, r.procStart))
    .map((record) => ({ record, window: bestWindow(record.cwd, locks, probe) }))
}

/**
 * A snapshot of the process list that the probe answers from synchronously. Its source is either
 * the native Toolhelp32 list (desktop) or the PowerShell fallback (below).
 */
export interface ProcessSnapshot {
  /** How many processes it lists. The probe treats an empty snapshot as a failure. */
  readonly size: number
  /** The pid's image name (the `Name` column of `Get-Process`), or `undefined` when it is not listed. */
  imageName(pid: number): string | undefined
  /**
   * The process's creation FILETIME as a decimal string (the format of `StartTime.ToFileTime()`),
   * or `undefined` when the pid is not listed or its start time cannot be read (access denied,
   * exited meanwhile).
   */
  startFileTime(pid: number): string | undefined
}

export interface SnapshotProbeOptions {
  /** How long a successful snapshot stays valid; `PROBE_TTL_MS` by default. */
  ttlMs?: number | undefined
  /** The clock, so the TTL can be tested. */
  now?: (() => number) | undefined
}

const EMPTY_SNAPSHOT: ProcessSnapshot = {
  size: 0,
  imageName: () => undefined,
  startFileTime: () => undefined,
}

/**
 * A `ProcessProbe` that answers synchronously from the latest successful snapshot; only `refresh()`
 * takes a new one, asynchronously, without blocking the main thread.
 *
 * This is the fix for the freeze: `isAlive`/`imageName` used to start the query themselves with
 * `execFileSync`, which stopped the whole app in the Electron main process (the overlay, the hotkey,
 * the daemon's HTTP server and with it the hooks), for up to 10 s under load.
 *
 * - Only one query runs at a time; callers arriving meanwhile get the same promise.
 * - A successful snapshot is valid for `ttlMs`. Until one has succeeded, it retries every 250 ms:
 *   the empty snapshot would show every session as dead, and waiting out a full TTL with that lie
 *   is worse than a quick retry.
 * - On an error or an empty result the previous snapshot is kept: one failed query must not wipe
 *   every session off the list. It logs once per run of failures, not on every poll.
 * - `refresh()` never rejects.
 *
 * `isAlive(pid, procStart)`: when the pid is listed but its start time cannot be read, the result
 * is `false`. We cannot prove it is the same process, and pid reuse would give exactly this false
 * positive. The old PowerShell snapshot behaved the same way: it skipped the processes whose
 * `StartTime` could not be read.
 */
export function createSnapshotProbe(
  take: () => Promise<ProcessSnapshot>,
  options: SnapshotProbeOptions = {},
): ProcessProbe {
  const ttlMs = options.ttlMs ?? PROBE_TTL_MS
  const now = options.now ?? (() => Date.now())
  let snapshot = EMPTY_SNAPSHOT
  let primed = false
  let attemptedAt: number | undefined
  let inFlight: Promise<void> | undefined
  let failing = false

  function fail(reason: unknown): void {
    if (failing) return
    failing = true
    console.error('[probe] process snapshot failed, keeping the previous one', reason)
  }

  async function attempt(): Promise<void> {
    try {
      const next = await take()
      if (next.size === 0) {
        fail(new Error('empty process snapshot'))
        return
      }
      snapshot = next
      primed = true
      if (failing) console.log('[probe] process snapshot recovered')
      failing = false
    } catch (error) {
      fail(error)
    }
  }

  return {
    isAlive(pid, procStart) {
      if (snapshot.imageName(pid) === undefined) return false
      if (procStart === undefined) return true
      return snapshot.startFileTime(pid) === procStart
    },
    imageName(pid) {
      return snapshot.imageName(pid)
    },
    startedAtMs(pid) {
      const fileTime = snapshot.startFileTime(pid)
      return fileTime === undefined ? undefined : fileTimeToEpochMs(fileTime)
    },
    refresh() {
      if (inFlight !== undefined) return inFlight
      const at = now()
      const interval = primed ? ttlMs : Math.min(ttlMs, 250)
      if (attemptedAt !== undefined && at - attemptedAt < interval) return Promise.resolve()
      attemptedAt = at
      inFlight = attempt().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}

const SNAPSHOT_SCRIPT = [
  'Get-Process | ForEach-Object {',
  '  try { "$($_.Id)`t$($_.StartTime.ToFileTime())`t$($_.Name)" } catch { }',
  '}',
].join(' ')

interface ProcessInfo {
  startFileTime: string
  image: string
}

/** The PowerShell snapshot's output (`pid<TAB>FILETIME<TAB>Name` per line) as a snapshot. */
export function parsePowerShellSnapshot(output: string): ProcessSnapshot {
  const processes = new Map<number, ProcessInfo>()
  for (const line of output.split('\n')) {
    const [rawPid, startFileTime, image] = line.trim().split('\t')
    if (rawPid === undefined || startFileTime === undefined || image === undefined) continue
    const pid = Number.parseInt(rawPid, 10)
    if (!Number.isNaN(pid)) processes.set(pid, { startFileTime, image })
  }
  return {
    size: processes.size,
    imageName: (pid) => processes.get(pid)?.image,
    startFileTime: (pid) => processes.get(pid)?.startFileTime,
  }
}

/**
 * The PowerShell snapshot's timeout. It can be slow even on an idle machine: on 2026-10-30 it took
 * 5.9 s on its own on a freshly set up machine (about 0.3 s on the previous one), and under the
 * load of a full test run it exceeded the former 10 s. `execFile` is asynchronous, so a longer
 * limit holds nothing up; it only decides when to give up.
 */
export const POWERSHELL_SNAPSHOT_TIMEOUT_MS = 30_000

function runPowerShellSnapshot(): Promise<ProcessSnapshot> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: POWERSHELL_SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) reject(new Error(`PowerShell snapshot failed: ${error.message}`, { cause: error }))
        else resolve(parsePowerShellSnapshot(stdout))
      },
    )
  })
}

/**
 * A Windows process probe using PowerShell, a FALLBACK only. The app uses the desktop's native
 * (koffi) probe; this one runs only when that cannot be loaded.
 *
 * `procStart` in the session file is the process creation FILETIME in decimal; PowerShell's
 * `StartTime.ToFileTime()` gives the same. It takes one snapshot of all processes, because
 * starting PowerShell per pid (~200 ms) is unacceptable. It runs with an asynchronous `execFile`,
 * so it does not block the main thread; `createSnapshotProbe` provides the TTL, the single
 * running query and the error handling.
 */
export function createWin32ProcessProbe(ttlMs = PROBE_TTL_MS): ProcessProbe {
  return createSnapshotProbe(runPowerShellSnapshot, { ttlMs })
}
