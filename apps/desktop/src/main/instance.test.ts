import { describe, expect, it } from 'vitest'
import {
  HANDOVER_TIMEOUT_MS,
  LAUNCH_EXIT_CODE,
  describeBuild,
  instanceAction,
  launchMode,
  parseInstanceMessage,
  parseInstanceRecord,
  sameBuild,
  type BuildIdentity,
} from './instance.js'
import { STOP_TIMEOUT_MS } from './shutdown.js'

const repoStart: BuildIdentity = {
  execPath: 'P:\\proj\\alpha\\node_modules\\electron\\dist\\electron.exe',
  appPath: 'P:\\proj\\alpha\\apps\\desktop',
  renderer: 'file',
  version: '0.0.0',
  packaged: false,
}

const installed: BuildIdentity = {
  execPath: 'C:\\Program Files\\ClaudeSwitcher\\ClaudeSwitcher.exe',
  appPath: 'C:\\Program Files\\ClaudeSwitcher\\resources\\app.asar',
  renderer: 'file',
  version: '1.2.0',
  packaged: true,
}

describe('launchMode', () => {
  it('reads the mode from the arguments', () => {
    expect(launchMode(['x.exe', '--quit'])).toBe('quit')
    expect(launchMode(['x.exe'])).toBe('normal')
    expect(launchMode(['x.exe', '--uninstall'])).toBe('uninstall')
  })

  it('finds the flag after the app path of a repo build', () => {
    expect(launchMode(['electron.exe', 'P:\\proj\\alpha\\apps\\desktop', '--quit'])).toBe('quit')
  })

  it('lets --uninstall win over --quit, because it does what --quit does and more', () => {
    expect(launchMode(['x.exe', '--quit', '--uninstall'])).toBe('uninstall')
  })
})

describe('sameBuild', () => {
  it('ignores case and slash direction in the paths', () => {
    const other: BuildIdentity = {
      ...repoStart,
      execPath: 'p:/PROJ/alpha/node_modules/electron/dist/Electron.exe',
      appPath: 'p:/proj/ALPHA/apps/desktop/',
    }
    expect(sameBuild(repoStart, other)).toBe(true)
  })

  it('tells dev from start by the renderer alone', () => {
    expect(sameBuild(repoStart, { ...repoStart, renderer: 'dev-server' })).toBe(false)
  })

  it('tells the installed app from a repo build', () => {
    expect(sameBuild(repoStart, installed)).toBe(false)
  })

  it('ignores the version, which is only for the text', () => {
    expect(sameBuild(installed, { ...installed, version: '1.3.0' })).toBe(true)
  })
})

describe('describeBuild', () => {
  it('names the three builds', () => {
    expect(describeBuild(installed)).toBe('telepített, 1.2.0')
    expect(describeBuild({ ...repoStart, renderer: 'dev-server' })).toBe('repóból, dev')
    expect(describeBuild(repoStart)).toBe('repóból, start')
  })
})

describe('parseInstanceMessage', () => {
  it('accepts both kinds', () => {
    expect(parseInstanceMessage({ kind: 'show', build: repoStart })).toEqual({ kind: 'show', build: repoStart })
    expect(parseInstanceMessage({ kind: 'quit' })).toEqual({ kind: 'quit' })
  })

  it('rejects a missing message, a show without a build, and an unknown kind', () => {
    expect(parseInstanceMessage(undefined)).toBeUndefined()
    expect(parseInstanceMessage({ kind: 'show' })).toBeUndefined()
    expect(parseInstanceMessage({ kind: 'restart' })).toBeUndefined()
  })

  it('rejects a build with a wrong field', () => {
    expect(parseInstanceMessage({ kind: 'show', build: { ...repoStart, renderer: 'vite' } })).toBeUndefined()
    expect(parseInstanceMessage({ kind: 'show', build: { ...repoStart, packaged: 'yes' } })).toBeUndefined()
  })
})

describe('instanceAction', () => {
  it('quits on a quit message', () => {
    expect(instanceAction({ kind: 'quit' }, repoStart)).toBe('quit')
  })

  it('shows the overlay for the same build, and for an older build that sends no message', () => {
    expect(instanceAction({ kind: 'show', build: { ...repoStart, version: '0.0.1' } }, repoStart)).toBe('show')
    expect(instanceAction(undefined, repoStart)).toBe('show')
  })

  it('ignores a different build: it shows its own hand-over dialog', () => {
    expect(instanceAction({ kind: 'show', build: installed }, repoStart)).toBe('ignore')
    expect(instanceAction({ kind: 'show', build: { ...repoStart, renderer: 'dev-server' } }, repoStart)).toBe('ignore')
  })
})

describe('parseInstanceRecord', () => {
  it('accepts a record', () => {
    expect(parseInstanceRecord({ pid: 4242, build: installed })).toEqual({ pid: 4242, build: installed })
  })

  it('rejects a non-integer or non-positive pid', () => {
    expect(parseInstanceRecord({ pid: 1.5, build: installed })).toBeUndefined()
    expect(parseInstanceRecord({ pid: 0, build: installed })).toBeUndefined()
    expect(parseInstanceRecord({ pid: -3, build: installed })).toBeUndefined()
    expect(parseInstanceRecord({ pid: '4242', build: installed })).toBeUndefined()
  })

  it('rejects a record without a valid build', () => {
    expect(parseInstanceRecord({ pid: 4242 })).toBeUndefined()
    expect(parseInstanceRecord(null)).toBeUndefined()
  })
})

describe('HANDOVER_TIMEOUT_MS', () => {
  it('outlasts the daemon stop of the running app', () => {
    expect(HANDOVER_TIMEOUT_MS).toBe(STOP_TIMEOUT_MS + 8000)
  })
})

describe('LAUNCH_EXIT_CODE', () => {
  it('keeps the codes the NSIS macros rely on', () => {
    expect(LAUNCH_EXIT_CODE).toEqual({ ok: 0, notClosed: 1, integrationFailed: 2 })
  })
})
