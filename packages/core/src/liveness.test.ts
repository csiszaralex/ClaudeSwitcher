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
  /** A process creation FILETIME, ahogy a session fájl tárolja. */
  procStart?: string
  /** A Get-Process `Name` megfelelője. */
  image?: string
  /** A processz indulása epoch ms-ban; hiányzik, ha nem kérdezhető le. */
  startedAtMs?: number
}

/** Csak a felsorolt pidek élnek. Ami nincs a táblában, az halott. */
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

/** A tipikus felállás: az élő session és a hozzá tartozó élő VSCode ablak. */
const ALIVE = { 100: { procStart: 'ps-100' }, 900: { image: 'Code' } }

describe('resolveLiveSessions', () => {
  it('drops sessions whose process is gone', () => {
    expect(resolveLiveSessions([session()], [lock()], probeFor({}))).toEqual([])
  })

  it('drops a session whose pid is alive but started at a different time', () => {
    // Pid-újrahasznosítás: a pid él, de már egy másik processz birtokolja.
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
    // A veszélyes eset: elárvult lock ugyanarra a workspace-re, aminek a pidjét
    // időközben egy teljesen független processz kapta meg. Élő pid, egyező
    // útvonal — csak az image név árulja el, hogy nem VSCode ablak.
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
    // Nem VSCode IDE-nél nem tudjuk, mi a helyes image név — inkább párosítunk,
    // mint hogy egy támogatott szerkesztőt kizárjunk.
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
    // A lock írásakor a pid még egy másik processzé volt: a mostani Code.exe később indult.
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
    // A review esete: az elavult lock mappája hosszabb, ezért a régi kód azt választotta.
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
  /** Hiányzik: a pid listázható, de az indulási ideje nem kérdezhető le (pl. access denied). */
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

/** Kézzel feloldható ígéret, hogy egy futó refresh-t meg lehessen tartani. */
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
    // A szinkron válaszok soha nem indítanak lekérdezést: ez a fagyás oka volt.
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
    // procStart-tal nem tudjuk igazolni, hogy ugyanaz a processz: halott.
    expect(probe.isAlive(300, 'ps-300')).toBe(false)
    // procStart nélkül a pid listázva van, tehát él.
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
  // Valódi PowerShellt indít: a teszt a pillanatkép saját korlátjánál tovább várhat, hogy egy lassú
  // gépen a probe döntsön (hiba vagy siker), ne a teszt időkorlátja.
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
