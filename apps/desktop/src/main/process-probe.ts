import { createRequire } from 'node:module'
import { PROBE_TTL_MS, createSnapshotProbe, type ProcessProbe, type ProcessSnapshot } from '@claudeswitcher/core'

// Not named `require`: in the module wrapper of the CJS bundle `require` already exists as a
// parameter, and a `const` of the same name would clash with it.
const requireNative = createRequire(import.meta.url)

const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const INVALID_HANDLE_VALUE = -1
const MAX_PATH = 260
/** The size of `PROCESSENTRY32W` on x64: 9 scalar fields (one an 8-byte ULONG_PTR) + 260 WCHARs. */
const PROCESSENTRY32W_SIZE_X64 = 568

/**
 * Upper bound on the processes walked. A desktop machine runs a few hundred processes; the bound
 * keeps an unexpectedly behaving `Process32NextW` from sending the Electron main process into an
 * endless loop, which would freeze the whole app.
 */
const MAX_PROCESSES = 100_000

/** The fields of `PROCESSENTRY32W`, as koffi converts between the JS object and the struct both ways. */
interface ProcessEntry32 {
  dwSize: number
  cntUsage: number
  th32ProcessID: number
  th32DefaultHeapID: number | bigint
  th32ModuleID: number
  cntThreads: number
  th32ParentProcessID: number
  pcPriClassBase: number
  dwFlags: number
  szExeFile: string
}

interface FileTime {
  dwLowDateTime: number
  dwHighDateTime: number
}

interface Kernel32 {
  /** `koffi.sizeof(PROCESSENTRY32W)`: it goes into `dwSize`; without it Process32FirstW fails. */
  entrySize: number
  // In koffi a HANDLE (`intptr`) return value can be a `number` or a `bigint` at run time.
  CreateToolhelp32Snapshot(flags: number, pid: number): number | bigint
  Process32FirstW(snapshot: number, entry: ProcessEntry32): number
  Process32NextW(snapshot: number, entry: ProcessEntry32): number
  OpenProcess(access: number, inherit: number, pid: number): number | bigint
  GetProcessTimes(process: number, creation: FileTime, exit: FileTime, kernel: FileTime, user: FileTime): number
  CloseHandle(handle: number): number
}

/** `undefined`: not tried yet. `null`: loading failed. */
let kernel32: Kernel32 | null | undefined

/**
 * Loads the kernel32 bindings lazily and swallows an error, for the same reason `focus-window.ts`
 * does with user32 (`loadUser32`): a module-level koffi error would throw before the startup error
 * dialog is wired up. With an unavailable native module the caller falls back to the PowerShell
 * probe; this is logged once, because the result is remembered.
 *
 * The structs are anonymous: koffi registers type names per process, and a reloaded module (a
 * test, HMR) could not define a named struct a second time.
 */
function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32
  try {
    const koffi = requireNative('koffi') as typeof import('koffi')
    const lib = koffi.load('kernel32.dll')
    const entryType = koffi.struct({
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: koffi.array('char16_t', MAX_PATH, 'String'),
    })
    const entrySize = koffi.sizeof(entryType)
    if (process.arch === 'x64' && entrySize !== PROCESSENTRY32W_SIZE_X64) {
      throw new Error(`unexpected PROCESSENTRY32W size ${String(entrySize)}`)
    }
    const fileTime = koffi.struct({ dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' })
    const entryPtr = koffi.inout(koffi.pointer(entryType))
    const fileTimeOut = koffi.out(koffi.pointer(fileTime))
    kernel32 = {
      entrySize,
      CreateToolhelp32Snapshot: lib.func('CreateToolhelp32Snapshot', 'intptr', ['uint32', 'uint32']),
      Process32FirstW: lib.func('Process32FirstW', 'int', ['intptr', entryPtr]),
      Process32NextW: lib.func('Process32NextW', 'int', ['intptr', entryPtr]),
      // A Win32 BOOL is a 4-byte int, not the 1-byte C bool.
      OpenProcess: lib.func('OpenProcess', 'intptr', ['uint32', 'int', 'uint32']),
      GetProcessTimes: lib.func('GetProcessTimes', 'int', ['intptr', fileTimeOut, fileTimeOut, fileTimeOut, fileTimeOut]),
      CloseHandle: lib.func('CloseHandle', 'int', ['intptr']),
    }
  } catch (error) {
    console.error('[probe] kernel32 bindings unavailable; falling back to the PowerShell probe', error)
    kernel32 = null
  }
  return kernel32
}

/**
 * The `Name` column of `Get-Process` from the exe name: without the `.exe` extension, keeping the
 * case (`Code.exe` → `Code`, `Code - Insiders.exe` → `Code - Insiders`). .NET does not cut any other
 * extension either, and the system processes (`Registry`, `System`) have none.
 */
export function imageNameFromExe(exe: string): string {
  return exe.replace(/\.exe$/i, '')
}

/**
 * The decimal string from the two 32-bit halves of a FILETIME: the same value
 * `StartTime.ToFileTime()` gave and the session file's `procStart` stores. The 64-bit value does
 * not fit exactly in a `number`, so it is put together with BigInt; the halves are taken as
 * unsigned.
 */
export function fileTimeToDecimal(low: number, high: number): string {
  return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)).toString()
}

/** A process from the Toolhelp32 list. */
export interface ProcessListEntry {
  pid: number
  image: string
}

/** A list entry from the relevant fields of the struct, or `undefined` if it has no name. */
export function entryFromStruct(raw: Pick<ProcessEntry32, 'th32ProcessID' | 'szExeFile'>): ProcessListEntry | undefined {
  const nul = raw.szExeFile.indexOf('\0')
  const exe = nul === -1 ? raw.szExeFile : raw.szExeFile.slice(0, nul)
  if (exe === '') return undefined
  return { pid: raw.th32ProcessID, image: imageNameFromExe(exe) }
}

/**
 * A snapshot from a process list. The start time is queried lazily, only for the pids actually
 * asked about (a scan asks about 20 to 30 pids, not all ~650), and at most once per pid: a failed
 * query is remembered too. A pid not on the list is not queried: it is dead, whatever might run on
 * that pid now.
 */
export function snapshotFromEntries(
  entries: readonly ProcessListEntry[],
  queryStart: (pid: number) => string | undefined,
): ProcessSnapshot {
  const images = new Map(entries.map((entry) => [entry.pid, entry.image]))
  /** `null`: queried, and it failed. */
  const starts = new Map<number, string | null>()
  return {
    size: images.size,
    imageName: (pid) => images.get(pid),
    startFileTime(pid) {
      if (!images.has(pid)) return undefined
      const cached = starts.get(pid)
      if (cached !== undefined) return cached ?? undefined
      const start = queryStart(pid)
      starts.set(pid, start ?? null)
      return start
    },
  }
}

function emptyEntry(size: number): ProcessEntry32 {
  return {
    dwSize: size,
    cntUsage: 0,
    th32ProcessID: 0,
    th32DefaultHeapID: 0,
    th32ModuleID: 0,
    cntThreads: 0,
    th32ParentProcessID: 0,
    pcPriClassBase: 0,
    dwFlags: 0,
    szExeFile: '',
  }
}

function listProcesses(api: Kernel32): ProcessListEntry[] {
  const handle = Number(api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0))
  if (handle === INVALID_HANDLE_VALUE || handle === 0) throw new Error('CreateToolhelp32Snapshot failed')
  try {
    const entry = emptyEntry(api.entrySize)
    const found: ProcessListEntry[] = []
    let more = api.Process32FirstW(handle, entry)
    for (let n = 0; more !== 0 && n < MAX_PROCESSES; n++) {
      const mapped = entryFromStruct(entry)
      if (mapped !== undefined) found.push(mapped)
      more = api.Process32NextW(handle, entry)
    }
    return found
  } finally {
    api.CloseHandle(handle)
  }
}

/**
 * The process's creation FILETIME, or `undefined` if it cannot be queried: access denied (another
 * user or a protected process), or the process exited meanwhile. The registry's sessions are
 * `claude` processes of the current user, and for them it succeeds.
 */
function queryStartTime(api: Kernel32, pid: number): string | undefined {
  const handle = Number(api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))
  if (handle === 0) return undefined
  try {
    const creation: FileTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
    const exit: FileTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
    const kernel: FileTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
    const user: FileTime = { dwLowDateTime: 0, dwHighDateTime: 0 }
    if (api.GetProcessTimes(handle, creation, exit, kernel, user) === 0) return undefined
    return fileTimeToDecimal(creation.dwLowDateTime, creation.dwHighDateTime)
  } finally {
    api.CloseHandle(handle)
  }
}

function snapshotWith(api: Kernel32): ProcessSnapshot {
  return snapshotFromEntries(listProcesses(api), (pid) => queryStartTime(api, pid))
}

/**
 * A native snapshot now, or `undefined` if the kernel32 bindings cannot be loaded. Throws on an
 * error. The probe uses the same snapshot; this is exported separately so the measurement and the
 * live test can see it directly.
 */
export function takeNativeSnapshot(): ProcessSnapshot | undefined {
  const api = loadKernel32()
  return api === null ? undefined : snapshotWith(api)
}

/**
 * The native Windows process probe, or `undefined` if the kernel32 bindings cannot be loaded: then
 * the caller falls back to the core PowerShell probe.
 *
 * `refresh()` takes the list on the main thread, without PowerShell. Measured at ~15 ms for ~680
 * processes (2026-10-22), almost all of it the `CreateToolhelp32Snapshot` kernel call itself (a raw
 * Buffer-based walk took the same), and querying the 20 to 30 start times took ~0.3 ms. That is
 * negligible next to the earlier 330 ms to 10 s of blocking, but not zero, so the TTL stays at the
 * old 2 s: the scans that the poll and the lifecycle hooks start often do not ask more often either.
 */
export function createNativeProcessProbe(ttlMs = PROBE_TTL_MS): ProcessProbe | undefined {
  const api = loadKernel32()
  if (api === null) return undefined
  return createSnapshotProbe(() => Promise.resolve(snapshotWith(api)), { ttlMs })
}
