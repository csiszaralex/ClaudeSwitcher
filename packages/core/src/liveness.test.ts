import { describe, expect, it } from 'vitest'
import { createWin32ProcessProbe, resolveLiveSessions, type ProcessProbe } from './liveness.js'
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

describe('createWin32ProcessProbe', () => {
  const onWindows = process.platform === 'win32'

  it.skipIf(!onWindows)('reports the current process as alive', () => {
    expect(createWin32ProcessProbe().isAlive(process.pid)).toBe(true)
  })

  it.skipIf(!onWindows)('reports an implausible pid as dead', () => {
    expect(createWin32ProcessProbe().isAlive(999_999_998)).toBe(false)
  })

  it.skipIf(!onWindows)('returns an image name for the current process', () => {
    expect(createWin32ProcessProbe().imageName(process.pid)).toMatch(/\S/)
  })

  it.skipIf(!onWindows)('rejects the current pid when the start time disagrees', () => {
    expect(createWin32ProcessProbe().isAlive(process.pid, 'not-a-filetime')).toBe(false)
  })
})
