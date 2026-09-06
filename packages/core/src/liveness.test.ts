import { describe, expect, it } from 'vitest'
import { resolveLiveSessions, type ProcessProbe } from './liveness.js'
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

/** Csak a felsorolt pid+procStart párokat tekinti élőnek. */
function probeFor(alive: Array<[number, string | undefined]>): ProcessProbe {
  return {
    isAlive: (pid, procStart) =>
      alive.some(([p, s]) => p === pid && s === procStart),
  }
}

describe('resolveLiveSessions', () => {
  it('drops sessions whose process is gone', () => {
    const probe = probeFor([])
    expect(resolveLiveSessions([session()], [lock()], probe)).toEqual([])
  })

  it('pairs a live session with the window whose workspace contains its cwd', () => {
    const probe = probeFor([[100, 'ps-100'], [900, undefined]])
    const out = resolveLiveSessions([session()], [lock()], probe)
    expect(out).toHaveLength(1)
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('matches a cwd nested below the workspace folder', () => {
    const probe = probeFor([[100, 'ps-100'], [900, undefined]])
    const s = session({ cwd: 'p:\\proj\\alpha\\apps\\api' })
    const out = resolveLiveSessions([s], [lock()], probe)
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('matches case-insensitively and ignores trailing separators', () => {
    const probe = probeFor([[100, 'ps-100'], [900, undefined]])
    const s = session({ cwd: 'P:/PROJ/Alpha/' })
    const out = resolveLiveSessions([s], [lock()], probe)
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('does not match a sibling directory with a shared prefix', () => {
    const probe = probeFor([[100, 'ps-100'], [900, undefined]])
    const s = session({ cwd: 'p:\\proj\\alpha-two' })
    const out = resolveLiveSessions([s], [lock()], probe)
    expect(out[0]!.window).toBeUndefined()
  })

  it('ignores a stale lock whose pid was reused by another process', () => {
    // Két lock ugyanazzal a piddel, különböző workspace-szel — pontosan ez a
    // helyzet a valós gépen. Az élő ablak az alpha-t tartja; a beta lock elárvult.
    const probe = probeFor([[100, 'ps-100'], [900, undefined]])
    const stale = lock({ port: 1001, pid: 901, workspaceFolders: ['p:\\proj\\beta'] })
    const out = resolveLiveSessions([session()], [stale, lock()], probe)
    expect(out[0]!.window?.port).toBe(1000)
  })

  it('leaves window undefined when no lock matches', () => {
    const probe = probeFor([[100, 'ps-100']])
    const out = resolveLiveSessions([session()], [], probe)
    expect(out).toHaveLength(1)
    expect(out[0]!.window).toBeUndefined()
  })

  it('prefers the most specific workspace folder when several match', () => {
    const probe = probeFor([[100, 'ps-100'], [900, undefined], [901, undefined]])
    const broad = lock({ port: 1000, pid: 900, workspaceFolders: ['p:\\proj'] })
    const exact = lock({ port: 1001, pid: 901, workspaceFolders: ['p:\\proj\\alpha'] })
    const out = resolveLiveSessions([session()], [broad, exact], probe)
    expect(out[0]!.window?.pid).toBe(901)
  })
})
