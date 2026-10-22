import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createNativeProcessProbe,
  entryFromStruct,
  fileTimeToDecimal,
  imageNameFromExe,
  snapshotFromEntries,
  takeNativeSnapshot,
} from './process-probe.js'

const onWindows = process.platform === 'win32'

describe('imageNameFromExe', () => {
  it('drops the .exe extension, like the Get-Process Name column', () => {
    expect(imageNameFromExe('Code.exe')).toBe('Code')
    expect(imageNameFromExe('node.exe')).toBe('node')
    expect(imageNameFromExe('claude.exe')).toBe('claude')
  })

  it('keeps spaces and inner dots', () => {
    expect(imageNameFromExe('Code - Insiders.exe')).toBe('Code - Insiders')
    expect(imageNameFromExe('my.tool.exe')).toBe('my.tool')
  })

  it('drops the extension case-insensitively, keeping the name as written', () => {
    expect(imageNameFromExe('NOTEPAD.EXE')).toBe('NOTEPAD')
  })

  it('leaves names without an .exe extension alone', () => {
    // A rendszerprocesszeknek (Registry, System, Memory Compression) nincs kiterjesztésük.
    expect(imageNameFromExe('Registry')).toBe('Registry')
    expect(imageNameFromExe('Memory Compression')).toBe('Memory Compression')
    expect(imageNameFromExe('setup.com')).toBe('setup.com')
  })
})

describe('fileTimeToDecimal', () => {
  it('joins the two 32-bit halves into the decimal FILETIME string', () => {
    expect(fileTimeToDecimal(2_309_737_967, 30_000_000)).toBe('128849021189737967')
  })

  it('treats the low half as unsigned', () => {
    expect(fileTimeToDecimal(0xffff_ffff, 0)).toBe('4294967295')
    expect(fileTimeToDecimal(-1, 0)).toBe('4294967295')
  })

  it('gives 0 for an empty FILETIME', () => {
    expect(fileTimeToDecimal(0, 0)).toBe('0')
  })
})

describe('entryFromStruct', () => {
  it('maps the pid and the exe name to the image name', () => {
    expect(entryFromStruct({ th32ProcessID: 1234, szExeFile: 'claude.exe' })).toEqual({ pid: 1234, image: 'claude' })
  })

  it('cuts the exe name at the first NUL', () => {
    expect(entryFromStruct({ th32ProcessID: 7, szExeFile: 'Code.exe\0\0garbage' })).toEqual({ pid: 7, image: 'Code' })
  })

  it('rejects an entry with no name', () => {
    expect(entryFromStruct({ th32ProcessID: 7, szExeFile: '' })).toBeUndefined()
  })
})

describe('snapshotFromEntries', () => {
  const entries = [
    { pid: 100, image: 'claude' },
    { pid: 900, image: 'Code' },
  ]

  it('answers image names from the list', () => {
    const snapshot = snapshotFromEntries(entries, () => undefined)
    expect(snapshot.size).toBe(2)
    expect(snapshot.imageName(900)).toBe('Code')
    expect(snapshot.imageName(5)).toBeUndefined()
  })

  it('queries a start time lazily, at most once per pid, including failures', () => {
    const query = vi.fn((pid: number) => (pid === 100 ? '133' : undefined))
    const snapshot = snapshotFromEntries(entries, query)
    expect(query).not.toHaveBeenCalled()
    expect(snapshot.startFileTime(100)).toBe('133')
    expect(snapshot.startFileTime(100)).toBe('133')
    expect(snapshot.startFileTime(900)).toBeUndefined()
    expect(snapshot.startFileTime(900)).toBeUndefined()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('never queries a pid that is not in the list', () => {
    const query = vi.fn(() => '1')
    const snapshot = snapshotFromEntries(entries, query)
    expect(snapshot.startFileTime(5)).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
})

describe('native process probe (live)', () => {
  it.skipIf(!onWindows)('loads the kernel32 bindings', () => {
    expect(createNativeProcessProbe()).toBeDefined()
  })

  it.skipIf(!onWindows)('lists the current process with its exe name', () => {
    const snapshot = takeNativeSnapshot()
    expect(snapshot).toBeDefined()
    expect(snapshot?.size).toBeGreaterThan(10)
    expect(snapshot?.imageName(process.pid)).toBe(path.basename(process.execPath, '.exe'))
  })

  it.skipIf(!onWindows)('reads the creation time of the current process', () => {
    const start = takeNativeSnapshot()?.startFileTime(process.pid)
    expect(start).toMatch(/^\d+$/)
    // FILETIME: 100 ns egységek 1601-01-01 óta.
    const startMs = Number(BigInt(start ?? '0') / 10_000n) - 11_644_473_600_000
    const expectedMs = Date.now() - process.uptime() * 1000
    expect(Math.abs(startMs - expectedMs)).toBeLessThan(5000)
  })

  it.skipIf(!onWindows)('answers through the probe API after a refresh', async () => {
    const probe = createNativeProcessProbe()
    const start = takeNativeSnapshot()?.startFileTime(process.pid)
    await probe?.refresh()
    expect(probe?.isAlive(process.pid)).toBe(true)
    expect(probe?.isAlive(process.pid, start)).toBe(true)
    expect(probe?.isAlive(process.pid, 'not-a-filetime')).toBe(false)
    expect(probe?.isAlive(999_999_998)).toBe(false)
    expect(probe?.imageName(process.pid)).toMatch(/\S/)
  })
})
