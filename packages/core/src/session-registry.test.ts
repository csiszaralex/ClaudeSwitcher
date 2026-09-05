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
  authToken: 'cc6b82e3-2562-4ff4-a85f-ea6c95aa57e7',
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
    const { sessionId, ...withoutId } = REAL_SESSION
    expect(parseSessionRecord(withoutId)).toBeNull()
    expect(parseSessionRecord(null)).toBeNull()
    expect(parseSessionRecord('nonsense')).toBeNull()
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
    const { workspaceFolders, ...bad } = REAL_LOCK
    expect(parseIdeLock(bad, 1)).toBeNull()
  })
})
