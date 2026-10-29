import { describe, expect, it } from 'vitest'
import { parseIdeLock, parseSessionRecord } from './session-registry.js'

const REAL_SESSION = {
  pid: 21548,
  sessionId: '02df22e9-0cb8-4e89-8124-fb3c597ee4f0',
  cwd: 'p:\\01_Fullstack\\journal',
  startedAt: 1788447404737,
  procStart: '134329210033019891',
  version: '2.1.259',
  kind: 'interactive',
  entrypoint: 'claude-vscode',
  name: 'journal-58',
  nameSource: 'derived',
  bridgeSessionId: 'session_01LtDxAq3W2y7XNbXfPk1nVF',
}

const REAL_LOCK = {
  pid: 8108,
  workspaceFolders: ['p:\\08_Apps\\ClaudeSwitcher'],
  ideName: 'Visual Studio Code',
  transport: 'ws',
  runningInWindows: true,
  authToken: '9602c76f-7555-46a2-be31-9507b93f4c64',
}

describe('parseSessionRecord', () => {
  it('parses a real session file', () => {
    const r = parseSessionRecord(REAL_SESSION)
    expect(r).not.toBeNull()
    expect(r!.pid).toBe(21548)
    expect(r!.sessionId).toBe('02df22e9-0cb8-4e89-8124-fb3c597ee4f0')
    expect(r!.cwd).toBe('p:\\01_Fullstack\\journal')
    expect(r!.procStart).toBe('134329210033019891')
    expect(r!.name).toBe('journal-58')
    expect(r!.bridgeSessionId).toBe('session_01LtDxAq3W2y7XNbXfPk1nVF')
  })

  it('tolerates a missing bridgeSessionId', () => {
    const r = parseSessionRecord({ ...REAL_SESSION, bridgeSessionId: null })
    expect(r!.bridgeSessionId).toBeNull()
  })

  it('survives unknown future fields', () => {
    const r = parseSessionRecord({ ...REAL_SESSION, somethingNew: { a: 1 } })
    expect(r).not.toBeNull()
  })

  it('returns null when a required field is missing', () => {
    const withoutId = Object.fromEntries(Object.entries(REAL_SESSION).filter(([k]) => k !== 'sessionId'))
    expect(parseSessionRecord(withoutId)).toBeNull()
    expect(parseSessionRecord(null)).toBeNull()
    expect(parseSessionRecord('nonsense')).toBeNull()
  })

  it('returns null when a required field has the wrong type', () => {
    expect(parseSessionRecord({ ...REAL_SESSION, pid: '21548' })).toBeNull()
    expect(parseSessionRecord({ ...REAL_SESSION, startedAt: 'yesterday' })).toBeNull()
    expect(parseSessionRecord({ ...REAL_SESSION, cwd: null })).toBeNull()
  })

  it('never throws, whatever shape it is handed', () => {
    // A never-throws szerződés globális megkötés: egy hibás fájl nem viheti
    // magával a többi sessiont. Ez a teszt tartja életben.
    for (const bad of [null, undefined, 'nonsense', 42, true, [], [REAL_SESSION]]) {
      expect(() => parseSessionRecord(bad)).not.toThrow()
      expect(parseSessionRecord(bad)).toBeNull()
    }
  })
})

// A 2.1.301-es rekord (2026-10-20, mérve), a pipe útvonala rövidítve.
const REAL_STATUS_SESSION = {
  pid: 13884,
  sessionId: '86f00485-4b4d-4afc-b4c5-a7d0331739c1',
  cwd: 'd:\\06_Bohem\\bohem-marketing',
  startedAt: 1792493825481,
  procStart: '134369674249683679',
  version: '2.1.301',
  peerProtocol: 1,
  peerFeatures: ['notify_idle', 'artifact_yield'],
  kind: 'interactive',
  entrypoint: 'claude-vscode',
  pidDomain: 'win32:alex',
  messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-x',
  name: 'bohem-marketing-c2',
  nameSource: 'derived',
  nameSince: 1792493825481,
  status: 'idle',
  updatedAt: 1792493825845,
  statusUpdatedAt: 1792493825845,
}

describe('parseSessionRecord — status, waitingFor, statusUpdatedAt', () => {
  it('reads the status fields of a real idle record', () => {
    const r = parseSessionRecord(REAL_STATUS_SESSION)
    expect(r?.status).toBe('idle')
    expect(r?.statusUpdatedAt).toBe(1792493825845)
    expect(r?.waitingFor).toBeUndefined()
  })

  it('reads a waiting record', () => {
    const r = parseSessionRecord({
      ...REAL_STATUS_SESSION,
      status: 'waiting',
      waitingFor: 'permission prompt',
      statusUpdatedAt: 1792493830000,
    })
    expect(r?.status).toBe('waiting')
    expect(r?.waitingFor).toBe('permission prompt')
    expect(r?.statusUpdatedAt).toBe(1792493830000)
  })

  it('keeps waitingFor: null as null', () => {
    expect(parseSessionRecord({ ...REAL_STATUS_SESSION, status: 'busy', waitingFor: null })?.waitingFor).toBeNull()
  })

  it('leaves the fields undefined on an older record without them', () => {
    const r = parseSessionRecord(REAL_SESSION)
    expect(r).not.toBeNull()
    expect(r?.status).toBeUndefined()
    expect(r?.waitingFor).toBeUndefined()
    expect(r?.statusUpdatedAt).toBeUndefined()
  })

  it('keeps an unknown status string as-is, and drops wrongly typed values', () => {
    expect(parseSessionRecord({ ...REAL_STATUS_SESSION, status: 'compacting' })?.status).toBe('compacting')
    const bad = parseSessionRecord({ ...REAL_STATUS_SESSION, status: 3, waitingFor: {}, statusUpdatedAt: 'now' })
    expect(bad).not.toBeNull()
    expect(bad?.status).toBeUndefined()
    expect(bad?.waitingFor).toBeUndefined()
    expect(bad?.statusUpdatedAt).toBeUndefined()
  })
})

describe('parseIdeLock', () => {
  it('parses a real lock file', () => {
    const l = parseIdeLock(REAL_LOCK, 50269)
    expect(l).not.toBeNull()
    expect(l!.port).toBe(50269)
    expect(l!.pid).toBe(8108)
    expect(l!.workspaceFolders).toEqual(['p:\\08_Apps\\ClaudeSwitcher'])
  })

  it('returns null without workspaceFolders', () => {
    const bad = Object.fromEntries(Object.entries(REAL_LOCK).filter(([k]) => k !== 'workspaceFolders'))
    expect(parseIdeLock(bad, 1)).toBeNull()
  })

  it('drops non-string entries from workspaceFolders', () => {
    const lock = parseIdeLock({ ...REAL_LOCK, workspaceFolders: [123, 'p:\\proj', null] }, 1)
    expect(lock!.workspaceFolders).toEqual(['p:\\proj'])
  })

  it('returns null when every workspace folder entry is unusable', () => {
    expect(parseIdeLock({ ...REAL_LOCK, workspaceFolders: [123, null] }, 1)).toBeNull()
  })

  it('never throws, whatever shape it is handed', () => {
    for (const bad of [null, undefined, 'nonsense', 42, true, []]) {
      expect(() => parseIdeLock(bad, 1)).not.toThrow()
      expect(parseIdeLock(bad, 1)).toBeNull()
    }
  })
})
