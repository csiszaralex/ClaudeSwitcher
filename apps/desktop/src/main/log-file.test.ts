import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import path from 'node:path'
import { tempDir } from '@claudeswitcher/core/testing'
import { describe, expect, it, vi } from 'vitest'
import {
  LOG_MAX_BYTES,
  OLD_LOG_FILE_NAME,
  ensureLogFile,
  installFileLog,
  logDir,
  logFilePath,
  type ConsoleTarget,
} from './log-file.js'

const PID = 4242
const FIXED_TIME = new Date('2026-11-13T08:30:00.000Z')

function fakeConsole(): { target: ConsoleTarget; log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const log = vi.fn()
  const warn = vi.fn()
  const error = vi.fn()
  return { target: { log, warn, error }, log, warn, error }
}

async function install(maxBytes?: number, rename?: (from: string, to: string) => void) {
  const userData = await tempDir('cs-log-')
  const fake = fakeConsole()
  installFileLog({
    userData,
    target: fake.target,
    now: () => FIXED_TIME,
    pid: PID,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(rename === undefined ? {} : { rename }),
  })
  return { userData, ...fake }
}

const read = (userData: string): Promise<string> => readFile(logFilePath(userData), 'utf8')

/**
 * `renameSync` that tries again while Windows refuses it for a moment (EPERM, EACCES, EBUSY: another
 * process, such as a virus scanner, has the file open). For the tests about which line lands in which
 * file; the refusal itself is the subject of its own test.
 */
function patientRename(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (attempt >= 50 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      // A synchronous 10 ms pause, at most about 0.5 s in all.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
}

describe('installFileLog', () => {
  it('writes one line with the time, the pid, the level and the formatted arguments', async () => {
    const { userData, target } = await install()
    target.log('[alpha] started', 3, { port: 1234 })
    target.warn('[alpha] careful')
    target.error('[alpha] failed')
    expect((await read(userData)).split('\n')).toEqual([
      `2026-11-13T08:30:00.000Z ${String(PID)} LOG [alpha] started 3 { port: 1234 }`,
      `2026-11-13T08:30:00.000Z ${String(PID)} WARN [alpha] careful`,
      `2026-11-13T08:30:00.000Z ${String(PID)} ERROR [alpha] failed`,
      '',
    ])
  })

  it('keeps the stack of an Error argument', async () => {
    const { userData, target } = await install()
    const failure = new Error('invented failure')
    target.error('[alpha] could not do it', failure)
    const text = await read(userData)
    expect(text).toContain('[alpha] could not do it Error: invented failure')
    expect(text).toContain('log-file.test.ts')
  })

  it('still calls the original method with the same arguments', async () => {
    const { target, log, warn, error } = await install()
    target.log('one', 1)
    target.warn('two')
    target.error('three', new Error('x'))
    expect(log).toHaveBeenCalledWith('one', 1)
    expect(warn).toHaveBeenCalledWith('two')
    expect(error).toHaveBeenCalledWith('three', expect.any(Error))
  })

  it('creates the log folder when it is missing, and appends to an existing file', async () => {
    const { userData, target } = await install()
    target.log('first')
    await rm(logDir(userData), { recursive: true })
    target.log('second')
    expect(await read(userData)).toBe(`2026-11-13T08:30:00.000Z ${String(PID)} LOG second\n`)
    target.log('third')
    expect((await read(userData)).trimEnd().split('\n')).toHaveLength(2)
  })

  it('moves a full file to the old name, replacing an older one, and starts a new file', async () => {
    const { userData, target } = await install(300, patientRename)
    const oldPath = path.join(logDir(userData), OLD_LOG_FILE_NAME)
    await mkdir(logDir(userData), { recursive: true })
    await writeFile(oldPath, 'a much older file\n')
    // One line is about 135 bytes: two fit under 300, the third starts a new file.
    for (const word of ['alpha', 'bravo', 'charlie']) target.log(word.repeat(20))
    const current = await read(userData)
    const old = await readFile(oldPath, 'utf8')
    expect(old).not.toContain('a much older file')
    expect(old).toContain('alpha'.repeat(20))
    expect(old).toContain('bravo'.repeat(20))
    expect(old).not.toContain('charlie')
    expect(current).toContain('charlie'.repeat(20))
    expect(current).not.toContain('bravo')
  })

  it('keeps logging into the current file while Windows refuses the rotation, and rotates on a later line', async () => {
    let refuse = true
    const rename = (from: string, to: string): void => {
      if (refuse) throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' })
      renameSync(from, to)
    }
    const { userData, target, log, warn, error } = await install(300, rename)
    const oldPath = path.join(logDir(userData), OLD_LOG_FILE_NAME)
    for (const word of ['alpha', 'bravo', 'charlie', 'delta']) target.log(word.repeat(20))
    // Both refused rotations kept every line, and the refusal was reported once, through the original console.
    expect(await read(userData)).toContain('delta'.repeat(20))
    expect(warn.mock.calls.filter(([first]) => String(first).startsWith('[log]'))).toHaveLength(1)
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('[log]'), expect.anything())

    refuse = false
    target.log('echo'.repeat(20))
    expect(await readFile(oldPath, 'utf8')).toContain('delta'.repeat(20))
    expect(await read(userData)).toContain('echo'.repeat(20))
    expect(log).toHaveBeenCalledTimes(5)
  })

  it('does not rotate an empty file for one oversized line', async () => {
    const { userData, target } = await install(50)
    target.log('x'.repeat(200))
    expect(await read(userData)).toContain('x'.repeat(200))
  })

  it('uses a one MiB limit by default', () => {
    expect(LOG_MAX_BYTES).toBe(1024 * 1024)
  })

  it('turns the file log off after one report through the original console.error, and never throws', async () => {
    const { userData, target, log, error } = await install()
    // A file where the folder should be makes every write fail.
    await writeFile(logDir(userData), 'not a folder')
    expect(() => {
      target.log('first')
      target.log('second')
      target.error('third')
    }).not.toThrow()
    expect(log).toHaveBeenCalledTimes(2)
    // The third call's own original run, plus exactly one report of the failed write.
    const reports = error.mock.calls.filter(([text]) => typeof text === 'string' && text.startsWith('[log] '))
    expect(reports).toHaveLength(1)
    expect(error).toHaveBeenCalledTimes(2)
  })
})

describe('ensureLogFile', () => {
  it('creates the folder and an empty file, and returns its path', async () => {
    const userData = await tempDir('cs-log-')
    const file = ensureLogFile(userData)
    expect(file).toBe(logFilePath(userData))
    expect(await readFile(file, 'utf8')).toBe('')
  })

  it('leaves an existing file untouched', async () => {
    const userData = await tempDir('cs-log-')
    ensureLogFile(userData)
    await writeFile(logFilePath(userData), 'kept\n')
    ensureLogFile(userData)
    expect(await read(userData)).toBe('kept\n')
  })
})
