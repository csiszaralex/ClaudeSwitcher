import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCK_MTIME_SLACK_MS,
  POWERSHELL_SNAPSHOT_TIMEOUT_MS,
  createSnapshotProbe,
  createWin32ProcessProbe,
  fileTimeToEpochMs,
  parsePowerShellSnapshot,
  resolveLiveSessions,
  type ProcessProbe,
  type ProcessSnapshot,
} from './liveness.js'
import type { IdeLock, SessionRecord } from './types.js'

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pid: 100,
    sessionId: 'sid-100',
    cwd: 'p:\\proj\\alpha',
    startedAt: 1,
    procStart: 'ps-100',
    ...over,
  }
}

function lock(over: Partial<IdeLock> = {}): IdeLock {
  return { port: 1000, pid: 900, workspaceFolders: ['p:\\proj\\alpha'], ...over }
}

interface FakeProcess {
  /** The process creation FILETIME, as the session file stores it. */
  procStart?: string
  /** The equivalent of Get-Process `Name`. */
  image?: string
  /** The process start in epoch ms; absent when it cannot be read. */
  startedAtMs?: number
}

/** Only the listed pids are alive. Whatever is not in the table is dead. */
function probeFor(processes: Record<number, FakeProcess>): ProcessProbe {
  return {
    isAlive: (pid, procStart) => {
      const proc = processes[pid]
      if (proc === undefined) return false
      return procStart === undefined || proc.procStart === procStart
    },
    imageName: (pid) => processes[pid]?.image,
    startedAtMs: (pid) => processes[pid]?.startedAtMs,
    refresh: () => Promise.resolve(),
  }
}

/** The typical setup: the live session and its live VS Code window. */
const ALIVE = { 100: { procStart: 'ps-100' }, 900: { image: 'Code' } }

describe('resolveLiveSessions', () => {
  it('drops sessions whose process is gone', () => {
    expect(resolveLiveSessions([session()], [lock()], probeFor({}))).toEqual([])
  })

  it('drops a session whose pid is alive but started at a different time', () => {
    // Pid reuse: the pid is alive, but another process owns it now.
    const probe = probeFor({ 100: { procStart: 'someone-else' }, 900: { image: 'Code' } })
    expect(resolveLiveSessions([session()], [lock()], probe)).toEqual([])
  })

  it('pairs a live session with the window whose workspace contains its cwd', () => {
    const out = resolveLiveSessions([session()], [lock()], probeFor(ALIVE))
    expect(out).toHaveLength(1)
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('matches a cwd nested below the workspace folder', () => {
    const s = session({ cwd: 'p:\\proj\\alpha\\apps\\api' })
    const out = resolveLiveSessions([s], [lock()], probeFor(ALIVE))
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('matches case-insensitively and ignores trailing separators', () => {
    const s = session({ cwd: 'P:/PROJ/Alpha/' })
    const out = resolveLiveSessions([s], [lock()], probeFor(ALIVE))
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('does not match a sibling directory with a shared prefix', () => {
    const s = session({ cwd: 'p:\\proj\\alpha-two' })
    const out = resolveLiveSessions([s], [lock()], probeFor(ALIVE))
    expect(out[0]!.window).toBeUndefined()
  })

  it('ignores a lock whose process is gone', () => {
    const stale = lock({ port: 1001, pid: 901, workspaceFolders: ['p:\\proj\\beta'] })
    const out = resolveLiveSessions([session()], [stale, lock()], probeFor(ALIVE))
    expect(out[0]!.window?.port).toBe(1000)
  })

  it('rejects a VSCode lock whose recycled pid now belongs to something else', () => {
    // The dangerous case: an orphaned lock for the same workspace whose pid has been taken by an
    // unrelated process meanwhile. A live pid and a matching path: only the image name shows it is
    // not a VS Code window.
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'notepad' } })
    const vscodeLock = lock({ ideName: 'Visual Studio Code' })
    const out = resolveLiveSessions([session()], [vscodeLock], probe)
    expect(out[0]!.window).toBeUndefined()
  })

  it('accepts a VSCode lock whose pid really is a VSCode process', () => {
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code' } })
    const vscodeLock = lock({ ideName: 'Visual Studio Code' })
    expect(resolveLiveSessions([session()], [vscodeLock], probe)[0]!.window?.pid).toBe(900)
  })

  it('accepts Code - Insiders as a VSCode process', () => {
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code - Insiders' } })
    const vscodeLock = lock({ ideName: 'Visual Studio Code - Insiders' })
    expect(resolveLiveSessions([session()], [vscodeLock], probe)[0]!.window?.pid).toBe(900)
  })

  it('skips the image check for a lock from an IDE it does not know', () => {
    // For an IDE other than VS Code we do not know the right image name: better to match than to
    // exclude a supported editor.
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'cursor' } })
    const other = lock({ ideName: 'Cursor' })
    expect(resolveLiveSessions([session()], [other], probe)[0]!.window?.pid).toBe(900)
  })

  it('leaves window undefined when no lock matches', () => {
    const out = resolveLiveSessions([session()], [], probeFor(ALIVE))
    expect(out).toHaveLength(1)
    expect(out[0]!.window).toBeUndefined()
  })

  it('prefers the most specific workspace folder when several match', () => {
    const probe = probeFor({
      100: { procStart: 'ps-100' },
      900: { image: 'Code' },
      901: { image: 'Code' },
    })
    const broad = lock({ port: 1000, pid: 900, workspaceFolders: ['p:\\proj'] })
    const exact = lock({ port: 1001, pid: 901, workspaceFolders: ['p:\\proj\\alpha'] })
    const out = resolveLiveSessions([session()], [broad, exact], probe)
    expect(out[0]!.window?.pid).toBe(901)
  })
})

describe('resolveLiveSessions with lock file times', () => {
  const WRITTEN = 1_700_000_000_000

  it('rejects a lock written before its pid process started, because the pid was recycled', () => {
    // When the lock was written, the pid belonged to another process: the current Code.exe started later.
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code', startedAtMs: WRITTEN + 60_000 } })
    const stale = lock({ ideName: 'Visual Studio Code', mtimeMs: WRITTEN })
    expect(resolveLiveSessions([session()], [stale], probe)[0]!.window).toBeUndefined()
  })

  it('keeps a lock written after its process started', () => {
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code', startedAtMs: WRITTEN - 60_000 } })
    const fresh = lock({ ideName: 'Visual Studio Code', mtimeMs: WRITTEN })
    expect(resolveLiveSessions([session()], [fresh], probe)[0]!.window?.pid).toBe(900)
  })

  it('allows a few seconds of slack between the lock time and the process start', () => {
    const atSlack = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code', startedAtMs: WRITTEN + LOCK_MTIME_SLACK_MS } })
    expect(resolveLiveSessions([session()], [lock({ mtimeMs: WRITTEN })], atSlack)[0]!.window?.pid).toBe(900)
    const pastSlack = probeFor({
      100: { procStart: 'ps-100' },
      900: { image: 'Code', startedAtMs: WRITTEN + LOCK_MTIME_SLACK_MS + 1 },
    })
    expect(resolveLiveSessions([session()], [lock({ mtimeMs: WRITTEN })], pastSlack)[0]!.window).toBeUndefined()
  })

  it('keeps a lock when its write time or the process start time is unknown', () => {
    const noStart = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code' } })
    expect(resolveLiveSessions([session()], [lock({ mtimeMs: WRITTEN })], noStart)[0]!.window?.pid).toBe(900)
    const started = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code', startedAtMs: WRITTEN + 60_000 } })
    expect(resolveLiveSessions([session()], [lock()], started)[0]!.window?.pid).toBe(900)
  })

  it('does not let a recycled stale lock with a longer folder win over a valid one', () => {
    // The case found in review: the stale lock's folder is longer, so the old code picked it.
    const probe = probeFor({
      100: { procStart: 'ps-100' },
      900: { image: 'Code', startedAtMs: WRITTEN - 60_000 },
      901: { image: 'Code', startedAtMs: WRITTEN + 60_000 },
    })
    const valid = lock({ port: 1000, pid: 900, workspaceFolders: ['p:\\proj'], mtimeMs: WRITTEN })
    const stale = lock({ port: 1001, pid: 901, workspaceFolders: ['p:\\proj\\alpha'], mtimeMs: WRITTEN })
    expect(resolveLiveSessions([session()], [stale, valid], probe)[0]!.window?.port).toBe(1000)
  })
})

describe('fileTimeToEpochMs', () => {
  it('converts a decimal FILETIME to epoch milliseconds', () => {
    expect(fileTimeToEpochMs('116444736000000000')).toBe(0)
    expect(fileTimeToEpochMs('133000000000000000')).toBe(1_655_526_400_000)
  })

  it('returns undefined for anything that is not a decimal FILETIME', () => {
    for (const bad of ['', 'ps-100', '-1', '12.5', ' 133000000000000000', '0x1F']) {
      expect(fileTimeToEpochMs(bad)).toBeUndefined()
    }
  })
})

interface FakeEntry {
  image: string
  /** Absent: the pid is listed, but its start time cannot be read (e.g. access denied). */
  start?: string
}

function fakeSnapshot(entries: Record<number, FakeEntry>): ProcessSnapshot {
  const map = new Map(Object.entries(entries).map(([pid, entry]) => [Number(pid), entry]))
  return {
    size: map.size,
    imageName: (pid) => map.get(pid)?.image,
    startFileTime: (pid) => map.get(pid)?.start,
  }
}

const CLAUDE = { 100: { image: 'claude', start: 'ps-100' } }

/** A promise resolved by hand, so a running refresh can be held. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('createSnapshotProbe', () => {
  let clock = 0
  const now = (): number => clock

  afterEach(() => {
    clock = 0
    vi.restoreAllMocks()
  })

  it('answers from an empty snapshot before the first refresh, without taking one', () => {
    const take = vi.fn(() => Promise.resolve(fakeSnapshot(CLAUDE)))
    const probe = createSnapshotProbe(take, { now })
    expect(probe.isAlive(100)).toBe(false)
    expect(probe.imageName(100)).toBeUndefined()
    // The synchronous answers never start a query: that was the cause of the freeze.
    expect(take).not.toHaveBeenCalled()
  })

  it('answers from the latest snapshot after a refresh', async () => {
    const probe = createSnapshotProbe(() => Promise.resolve(fakeSnapshot(CLAUDE)), { now })
    await probe.refresh()
    expect(probe.isAlive(100, 'ps-100')).toBe(true)
    expect(probe.isAlive(100, 'someone-else')).toBe(false)
    expect(probe.isAlive(100)).toBe(true)
    expect(probe.imageName(100)).toBe('claude')
    expect(probe.isAlive(200)).toBe(false)
  })

  it('treats a listed pid without a readable start time as unverifiable', async () => {
    const probe = createSnapshotProbe(() => Promise.resolve(fakeSnapshot({ 300: { image: 'svchost' } })), { now })
    await probe.refresh()
    // With procStart we cannot prove it is the same process: dead.
    expect(probe.isAlive(300, 'ps-300')).toBe(false)
    // Without procStart the pid is listed, so it is alive.
    expect(probe.isAlive(300)).toBe(true)
    expect(probe.imageName(300)).toBe('svchost')
  })

  it('answers the process start time in epoch ms from the snapshot FILETIME', async () => {
    const probe = createSnapshotProbe(
      () => Promise.resolve(fakeSnapshot({ 900: { image: 'Code', start: '133000000000000000' }, 300: { image: 'svchost' } })),
      { now },
    )
    expect(probe.startedAtMs(900)).toBeUndefined()
    await probe.refresh()
    expect(probe.startedAtMs(900)).toBe(1_655_526_400_000)
    expect(probe.startedAtMs(300)).toBeUndefined()
    expect(probe.startedAtMs(200)).toBeUndefined()
  })

  it('shares one in-flight refresh between concurrent callers', async () => {
    const pending = deferred<ProcessSnapshot>()
    const take = vi.fn(() => pending.promise)
    const probe = createSnapshotProbe(take, { now })
    const first = probe.refresh()
    const second = probe.refresh()
    expect(take).toHaveBeenCalledTimes(1)
    pending.resolve(fakeSnapshot(CLAUDE))
    await Promise.all([first, second])
    expect(probe.isAlive(100, 'ps-100')).toBe(true)
  })

  it('does not take a new snapshot within the TTL', async () => {
    const take = vi.fn(() => Promise.resolve(fakeSnapshot(CLAUDE)))
    const probe = createSnapshotProbe(take, { now, ttlMs: 2000 })
    await probe.refresh()
    clock = 1999
    await probe.refresh()
    expect(take).toHaveBeenCalledTimes(1)
    clock = 2000
    await probe.refresh()
    expect(take).toHaveBeenCalledTimes(2)
  })

  it('retries every 250 ms until the first snapshot succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const take = vi.fn(() => Promise.reject(new Error('boom')))
    const probe = createSnapshotProbe(take, { now, ttlMs: 2000 })
    await probe.refresh()
    clock = 249
    await probe.refresh()
    expect(take).toHaveBeenCalledTimes(1)
    clock = 250
    await probe.refresh()
    expect(take).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous snapshot when a refresh fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const take = vi
      .fn<() => Promise<ProcessSnapshot>>()
      .mockResolvedValueOnce(fakeSnapshot(CLAUDE))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const probe = createSnapshotProbe(take, { now, ttlMs: 2000 })
    await probe.refresh()
    clock = 2000
    await probe.refresh()
    expect(take).toHaveBeenCalledTimes(2)
    expect(probe.isAlive(100, 'ps-100')).toBe(true)
  })

  it('keeps the previous snapshot when a refresh returns an empty one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const take = vi
      .fn<() => Promise<ProcessSnapshot>>()
      .mockResolvedValueOnce(fakeSnapshot(CLAUDE))
      .mockResolvedValueOnce(fakeSnapshot({}))
    const probe = createSnapshotProbe(take, { now, ttlMs: 2000 })
    await probe.refresh()
    clock = 2000
    await probe.refresh()
    expect(probe.isAlive(100, 'ps-100')).toBe(true)
  })

  it('logs a failure streak once, and a new streak again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const take = vi
      .fn<() => Promise<ProcessSnapshot>>()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockRejectedValueOnce(new Error('three'))
      .mockResolvedValueOnce(fakeSnapshot(CLAUDE))
      .mockRejectedValueOnce(new Error('four'))
    const probe = createSnapshotProbe(take, { now, ttlMs: 2000 })
    for (let i = 0; i < 5; i++) {
      clock = i * 2000
      await probe.refresh()
    }
    expect(take).toHaveBeenCalledTimes(5)
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('never rejects, even when taking the snapshot throws synchronously', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const probe = createSnapshotProbe(() => {
      throw new Error('sync')
    }, { now })
    await expect(probe.refresh()).resolves.toBeUndefined()
  })
})

describe('parsePowerShellSnapshot', () => {
  it('reads pid, start time and name, skipping malformed lines', () => {
    const snapshot = parsePowerShellSnapshot(
      '100\t133000000000000000\tclaude\r\nnot a line\r\nabc\t1\tx\r\n900\t133000000000000001\tCode - Insiders\r\n',
    )
    expect(snapshot.size).toBe(2)
    expect(snapshot.imageName(100)).toBe('claude')
    expect(snapshot.startFileTime(100)).toBe('133000000000000000')
    expect(snapshot.imageName(900)).toBe('Code - Insiders')
    expect(snapshot.imageName(200)).toBeUndefined()
  })
})

describe('createWin32ProcessProbe', () => {
  const onWindows = process.platform === 'win32'
  // Starts a real PowerShell: the test may wait longer than the snapshot's own timeout, so that on a
  // slow machine the probe decides (failure or success), not the test's timeout.
  const LIVE_TEST_TIMEOUT_MS = POWERSHELL_SNAPSHOT_TIMEOUT_MS + 10_000

  it.skipIf(!onWindows)('reports the current process as alive after a refresh', async () => {
    const probe = createWin32ProcessProbe()
    await probe.refresh()
    expect(probe.isAlive(process.pid)).toBe(true)
  }, LIVE_TEST_TIMEOUT_MS)

  it.skipIf(!onWindows)('reports an implausible pid as dead', async () => {
    const probe = createWin32ProcessProbe()
    await probe.refresh()
    expect(probe.isAlive(999_999_998)).toBe(false)
  }, LIVE_TEST_TIMEOUT_MS)

  it.skipIf(!onWindows)('returns an image name for the current process', async () => {
    const probe = createWin32ProcessProbe()
    await probe.refresh()
    expect(probe.imageName(process.pid)).toMatch(/\S/)
  }, LIVE_TEST_TIMEOUT_MS)

  it.skipIf(!onWindows)('rejects the current pid when the start time disagrees', async () => {
    const probe = createWin32ProcessProbe()
    await probe.refresh()
    expect(probe.isAlive(process.pid, 'not-a-filetime')).toBe(false)
  }, LIVE_TEST_TIMEOUT_MS)
})
