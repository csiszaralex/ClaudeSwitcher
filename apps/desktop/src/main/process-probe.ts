import { createRequire } from 'node:module'
import { createSnapshotProbe, type ProcessProbe, type ProcessSnapshot } from '@claudeswitcher/core'

// Nem `require`-nek nevezzük: a CJS bundle modulburkolójában a `require` már
// paraméterként létezik, és egy azonos nevű `const` ütközne vele.
const requireNative = createRequire(import.meta.url)

const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const INVALID_HANDLE_VALUE = -1
const MAX_PATH = 260
/** A `PROCESSENTRY32W` mérete x64-en: 9 skalár mező (egy 8 bájtos ULONG_PTR-rel) + 260 WCHAR. */
const PROCESSENTRY32W_SIZE_X64 = 568

/**
 * Felső korlát a bejárt processzek számára. Egy asztali gépen néhány száz processz fut; a
 * korlát azt védi ki, hogy egy váratlanul viselkedő `Process32NextW` végtelen ciklusba ejtse
 * az Electron főprocesszt, ami az egész appot lefagyasztaná.
 */
const MAX_PROCESSES = 100_000

/** A `PROCESSENTRY32W` mezői, ahogy a koffi a JS objektum és a struct között oda-vissza alakítja. */
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
  /** A `koffi.sizeof(PROCESSENTRY32W)`: ez kerül a `dwSize`-ba, enélkül a Process32FirstW elbukik. */
  entrySize: number
  // A HANDLE (`intptr`) visszatérés koffi-ben futásidőben `number` vagy `bigint` lehet.
  CreateToolhelp32Snapshot(flags: number, pid: number): number | bigint
  Process32FirstW(snapshot: number, entry: ProcessEntry32): number
  Process32NextW(snapshot: number, entry: ProcessEntry32): number
  OpenProcess(access: number, inherit: number, pid: number): number | bigint
  GetProcessTimes(process: number, creation: FileTime, exit: FileTime, kernel: FileTime, user: FileTime): number
  CloseHandle(handle: number): number
}

/** `undefined`: még nem próbáltuk. `null`: a betöltés elbukott. */
let kernel32: Kernel32 | null | undefined

/**
 * Lustán tölti be a kernel32 kötéseket, és egy hibát elnyel — ugyanazért, amiért a
 * `focus-window.ts` a user32-t: egy modulszintű koffi-hiba az indulási hibadialógus bekötése
 * előtt dobna. Elérhetetlen natív modulnál a hívó a PowerShell tartalékra esik vissza; ezt
 * egyszer naplózzuk, mert az eredményt megjegyezzük.
 *
 * A structok névtelenek: a koffi a típusneveket processz-szinten regisztrálja, és egy
 * újratöltött modul (teszt, HMR) egy névvel ellátott structot másodszor már nem definiálhatna.
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
      // A Win32 BOOL egy 4 bájtos int, nem az 1 bájtos C bool.
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
 * Az exe névből a `Get-Process` `Name` oszlopa: a `.exe` kiterjesztés nélkül, a betűméretet
 * megtartva (`Code.exe` → `Code`, `Code - Insiders.exe` → `Code - Insiders`). Más kiterjesztést
 * a .NET sem vág le, és a rendszerprocesszeknek (`Registry`, `System`) nincs is.
 */
export function imageNameFromExe(exe: string): string {
  return exe.replace(/\.exe$/i, '')
}

/**
 * Egy FILETIME két 32 bites feléből a decimális string, ugyanaz, amit a
 * `StartTime.ToFileTime()` adott, és amit a session fájl `procStart`-ja tárol. A 64 bites
 * érték nem fér el pontosan egy `number`-ben, ezért BigInt-tel rakjuk össze; a feleket
 * előjel nélkülinek vesszük.
 */
export function fileTimeToDecimal(low: number, high: number): string {
  return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)).toString()
}

/** Egy processz a Toolhelp32 listából. */
export interface ProcessListEntry {
  pid: number
  image: string
}

/** A struct releváns mezőiből egy listaelem, vagy `undefined`, ha nincs neve. */
export function entryFromStruct(raw: Pick<ProcessEntry32, 'th32ProcessID' | 'szExeFile'>): ProcessListEntry | undefined {
  const nul = raw.szExeFile.indexOf('\0')
  const exe = nul === -1 ? raw.szExeFile : raw.szExeFile.slice(0, nul)
  if (exe === '') return undefined
  return { pid: raw.th32ProcessID, image: imageNameFromExe(exe) }
}

/**
 * Pillanatkép egy processzlistából. Az indulási időt lustán kérdezzük le, csak a ténylegesen
 * megkérdezett pidekre (egy szkennelés 20–30 pid, nem mind a ~650), és pidenként legfeljebb
 * egyszer — a sikertelen lekérdezést is megjegyezzük. Listán kívüli pidet nem kérdezünk le:
 * az halott, akármi is futna most azon a pid-en.
 */
export function snapshotFromEntries(
  entries: readonly ProcessListEntry[],
  queryStart: (pid: number) => string | undefined,
): ProcessSnapshot {
  const images = new Map(entries.map((entry) => [entry.pid, entry.image]))
  /** `null`: lekérdeztük, és nem sikerült. */
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
 * A processz creation FILETIME-ja, vagy `undefined`, ha nem kérdezhető le: access denied
 * (egy másik felhasználó vagy egy védett processz), vagy a processz közben kilépett. A
 * registry sessionjei a saját felhasználónk `claude` processzei, náluk ez sikerül.
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
 * Egy natív pillanatkép most, vagy `undefined`, ha a kernel32 kötések nem tölthetők be. Hibánál
 * dob. A probe ezt használja; külön is elérhető, hogy a mérés és a live teszt közvetlenül lássa.
 */
export function takeNativeSnapshot(): ProcessSnapshot | undefined {
  const api = loadKernel32()
  return api === null ? undefined : snapshotWith(api)
}

/**
 * A natív Windows process probe, vagy `undefined`, ha a kernel32 kötések nem tölthetők be —
 * ilyenkor a hívó a core PowerShell probe-jára esik vissza.
 *
 * A `refresh()` a fő szálon veszi a listát, PowerShell nélkül. Ezen a gépen ~15 ms ~680
 * processzre (2026-10-22), és ennek szinte egésze maga a `CreateToolhelp32Snapshot` kernelhívás
 * — egy nyers Buffer-es bejárás ugyanennyi volt —, a 20–30 indulási idő lekérdezése ~0,3 ms.
 * Ez elhanyagolható a korábbi 330 ms–10 s blokkoláshoz képest, de nem nulla, ezért a TTL a
 * régi 2 s marad: a fájlfigyelő által sűrűn indított szkennelések sem kérnek gyakrabban.
 */
export function createNativeProcessProbe(ttlMs = 2000): ProcessProbe | undefined {
  const api = loadKernel32()
  if (api === null) return undefined
  return createSnapshotProbe(() => Promise.resolve(snapshotWith(api)), { ttlMs })
}
