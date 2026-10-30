import { execFile } from 'node:child_process'
import { PROBE_TTL_MS } from './timings.js'
import type { IdeLock, LiveSession, SessionRecord } from './types.js'

export interface ProcessProbe {
  /**
   * Igaz, ha a pid létezik ÉS — ha `procStart` meg van adva — a process
   * indulási ideje egyezik. A pid önmagában nem elég: a Windows újrahasznosítja
   * a pideket, és az elárvult lock fájlok miatt rossz ablakra ugranánk.
   */
  isAlive(pid: number, procStart?: string): boolean
  /**
   * A processz image neve (a `Get-Process` `Name` oszlopa), vagy `undefined`,
   * ha a pid nem él. A lock fájlok nem tárolnak `procStart`-ot, így náluk ez és a
   * `startedAtMs` a két fogódzó annak eldöntésére, hogy a pid tényleg a bejegyzett
   * IDE-hez tartozik-e, vagy időközben újrahasznosították.
   */
  imageName(pid: number): string | undefined
  /**
   * A processz indulása epoch ms-ban, vagy `undefined`, ha a pid nem él, vagy az indulási ideje
   * nem kérdezhető le. A lock fájloknál ezzel vehető észre, ha a pidet a lock írása után egy
   * újonnan indult processz kapta meg (lásd `lockPredatesProcess`).
   */
  startedAtMs(pid: number): number | undefined
  /**
   * Új pillanatképet vesz, ha az előző elavult. Az `isAlive` és az `imageName` szinkron,
   * és mindig a legutóbbi pillanatképből válaszol — a lekérdezés soha nem fut bennük,
   * mert a probe az Electron főprocesszben él, és ott minden blokkoló hívás az egész
   * appot megállítja. A szkennelés ezért egyszer, a sessionök feloldása előtt hívja.
   * Soha nem utasít el: hibánál az előző pillanatkép marad érvényben.
   */
  refresh(): Promise<void>
}

/** A `Get-Process` szerinti image nevek, amik VSCode ablakot jelentenek. */
const VSCODE_IMAGE_NAMES = new Set(['code', 'code - insiders'])

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Igaz, ha `child` azonos `parent`-tel vagy alatta van. */
function isWithin(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(p + '\\')
}

/**
 * Ennyivel indulhat a processz a lock fájl utolsó írása UTÁN úgy, hogy a lockot még az övének
 * tekintjük. A fájl időbélyegét és a processz indulási idejét két külön mechanizmus rögzíti, eltérő
 * felbontással; néhány másodperc tűrés ezt elnyeli. Egy pid-újrahasznosítás ennél jóval nagyobb
 * különbséget ad: a review mérésén (2026-10-25) a 139 lockból 116 hét napnál régebbi volt.
 */
export const LOCK_MTIME_SLACK_MS = 5000

/** A FILETIME (100 ns-os egységek 1601-01-01 óta) és az epoch közötti eltolás ms-ban. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n

/**
 * Egy decimális FILETIME string (a `ProcessSnapshot.startFileTime` formátuma) epoch ms-ban, vagy
 * `undefined`, ha nem csupa számjegy. BigInt-tel számol, mert a FILETIME nagyobb, mint amit egy
 * `number` pontosan tárol.
 */
export function fileTimeToEpochMs(fileTime: string): number | undefined {
  if (!/^\d+$/.test(fileTime)) return undefined
  return Number(BigInt(fileTime) / 10_000n - FILETIME_EPOCH_OFFSET_MS)
}

/**
 * Igaz, ha a lock fájlt azelőtt írták utoljára, hogy a pidje mostani processze elindult (a
 * `LOCK_MTIME_SLACK_MS` tűrésen túl). Ilyenkor a lockot egy azóta kilépett processz hagyta itt, és
 * a pidjét egy később indult processz kapta meg. A lockba írt pid processze az írás pillanatában
 * már futott, tehát egy élő lockra ez nem igaz. Ha bármelyik idő ismeretlen, hamis: tipp alapján
 * nem dobunk el lockot.
 */
function lockPredatesProcess(lockMtimeMs: number | undefined, processStartMs: number | undefined): boolean {
  if (lockMtimeMs === undefined || processStartMs === undefined) return false
  return processStartMs > lockMtimeMs + LOCK_MTIME_SLACK_MS
}

/**
 * Igaz, ha a lock pidje tényleg az a fajta processz, aminek a lock mondja.
 *
 * A veszélyes eset, ami ellen véd: egy elárvult lock ugyanarra a workspace-re,
 * aminek a pidjét időközben egy független processz kapta meg. A pid él, az
 * útvonal egyezik. Két jel árulja el:
 * - az idő: a processz a lock utolsó írása után indult (`lockPredatesProcess`). Ez akkor is
 *   működik, ha a pidet egy másik `Code.exe` segédprocessz kapta meg, amin az image név átmenne;
 * - az image név: nem VSCode processz. Ismeretlen IDE-nél ezt nem nézzük: inkább párosítunk,
 *   mint hogy egy támogatott szerkesztőt kizárjunk egy tipp alapján.
 */
function ownsLock(lock: IdeLock, probe: ProcessProbe): boolean {
  const image = probe.imageName(lock.pid)
  if (image === undefined) return false
  if (lockPredatesProcess(lock.mtimeMs, probe.startedAtMs(lock.pid))) return false
  if (lock.ideName === undefined || !/visual studio code/i.test(lock.ideName)) return true
  return VSCODE_IMAGE_NAMES.has(image.toLowerCase())
}

function bestWindow(cwd: string, locks: IdeLock[], probe: ProcessProbe): IdeLock | undefined {
  let best: IdeLock | undefined
  let bestLength = -1

  for (const lock of locks) {
    if (!ownsLock(lock, probe)) continue
    for (const folder of lock.workspaceFolders) {
      if (!isWithin(cwd, folder)) continue
      const length = normalize(folder).length
      if (length > bestLength) {
        best = lock
        bestLength = length
      }
    }
  }
  return best
}

export function resolveLiveSessions(
  records: SessionRecord[],
  locks: IdeLock[],
  probe: ProcessProbe,
): LiveSession[] {
  return records
    .filter((r) => probe.isAlive(r.pid, r.procStart))
    .map((record) => ({ record, window: bestWindow(record.cwd, locks, probe) }))
}

/**
 * Egy processzlista-pillanatkép, amiből a probe szinkron válaszol. A forrása lehet a natív
 * Toolhelp32 lista (desktop) vagy a PowerShell tartalék (lent).
 */
export interface ProcessSnapshot {
  /** Hány processz szerepel benne. Az üres pillanatképet a probe hibának veszi. */
  readonly size: number
  /** A pid image neve (a `Get-Process` `Name` oszlopa), vagy `undefined`, ha nem szerepel. */
  imageName(pid: number): string | undefined
  /**
   * A processz creation FILETIME-ja decimális stringként (a `StartTime.ToFileTime()`
   * formátuma), vagy `undefined`, ha a pid nem szerepel, vagy az indulási ideje nem
   * kérdezhető le (access denied, közben kilépett).
   */
  startFileTime(pid: number): string | undefined
}

export interface SnapshotProbeOptions {
  /** Ennyi ideig érvényes egy sikeres pillanatkép, alapból `PROBE_TTL_MS`. */
  ttlMs?: number | undefined
  /** Az óra, hogy a TTL tesztelhető legyen. */
  now?: (() => number) | undefined
}

const EMPTY_SNAPSHOT: ProcessSnapshot = {
  size: 0,
  imageName: () => undefined,
  startFileTime: () => undefined,
}

/**
 * Egy `ProcessProbe`, ami a legutóbbi sikeres pillanatképből válaszol szinkron, és csak a
 * `refresh()` vesz újat — aszinkron, a fő szál blokkolása nélkül.
 *
 * Ez a fagyás javítása: korábban az `isAlive`/`imageName` maga indította a lekérdezést egy
 * `execFileSync`-kel, ami az Electron főprocesszben az egész appot megállította (az overlayt,
 * a gyorsbillentyűt, a daemon HTTP szerverét és vele a hookokat), terhelés alatt 10 s-ig.
 *
 * - Egyszerre csak egy lekérdezés fut; a közben érkező hívók ugyanazt az ígéretet kapják.
 * - Egy sikeres pillanatkép `ttlMs`-ig érvényes. Amíg egyszer sem sikerült, 250 ms-onként
 *   próbálkozunk: az üres pillanatkép minden sessiont halottnak mutatna, és a teljes TTL-t
 *   végigvárni ezzel a hazugsággal rosszabb, mint egy gyors újrapróbálkozás.
 * - Hiba vagy üres eredmény esetén az előzőt tartjuk meg — egy elbukott lekérdezés ne
 *   tüntesse el az összes sessiont a listáról. Hibasorozatonként egyszer naplózunk, nem
 *   minden pollnál.
 * - A `refresh()` soha nem utasít el.
 *
 * `isAlive(pid, procStart)`: ha a pid listázva van, de az indulási ideje nem kérdezhető le,
 * az eredmény `false`. Nem tudjuk igazolni, hogy ugyanaz a processz, és a pid-újrahasznosítás
 * pont ilyen hamis pozitívot adna. A régi PowerShell pillanatkép ugyanígy viselkedett: azokat
 * a processzeket, amelyeknek a `StartTime`-ja nem olvasható, kihagyta.
 */
export function createSnapshotProbe(
  take: () => Promise<ProcessSnapshot>,
  options: SnapshotProbeOptions = {},
): ProcessProbe {
  const ttlMs = options.ttlMs ?? PROBE_TTL_MS
  const now = options.now ?? (() => Date.now())
  let snapshot = EMPTY_SNAPSHOT
  let primed = false
  let attemptedAt: number | undefined
  let inFlight: Promise<void> | undefined
  let failing = false

  function fail(reason: unknown): void {
    if (failing) return
    failing = true
    console.error('[probe] process snapshot failed, keeping the previous one', reason)
  }

  async function attempt(): Promise<void> {
    try {
      const next = await take()
      if (next.size === 0) {
        fail(new Error('empty process snapshot'))
        return
      }
      snapshot = next
      primed = true
      if (failing) console.log('[probe] process snapshot recovered')
      failing = false
    } catch (error) {
      fail(error)
    }
  }

  return {
    isAlive(pid, procStart) {
      if (snapshot.imageName(pid) === undefined) return false
      if (procStart === undefined) return true
      return snapshot.startFileTime(pid) === procStart
    },
    imageName(pid) {
      return snapshot.imageName(pid)
    },
    startedAtMs(pid) {
      const fileTime = snapshot.startFileTime(pid)
      return fileTime === undefined ? undefined : fileTimeToEpochMs(fileTime)
    },
    refresh() {
      if (inFlight !== undefined) return inFlight
      const at = now()
      const interval = primed ? ttlMs : Math.min(ttlMs, 250)
      if (attemptedAt !== undefined && at - attemptedAt < interval) return Promise.resolve()
      attemptedAt = at
      inFlight = attempt().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}

const SNAPSHOT_SCRIPT = [
  'Get-Process | ForEach-Object {',
  '  try { "$($_.Id)`t$($_.StartTime.ToFileTime())`t$($_.Name)" } catch { }',
  '}',
].join(' ')

interface ProcessInfo {
  startFileTime: string
  image: string
}

/** A PowerShell pillanatkép kimenete (`pid<TAB>FILETIME<TAB>Name` soronként) pillanatképként. */
export function parsePowerShellSnapshot(output: string): ProcessSnapshot {
  const processes = new Map<number, ProcessInfo>()
  for (const line of output.split('\n')) {
    const [rawPid, startFileTime, image] = line.trim().split('\t')
    if (rawPid === undefined || startFileTime === undefined || image === undefined) continue
    const pid = Number.parseInt(rawPid, 10)
    if (!Number.isNaN(pid)) processes.set(pid, { startFileTime, image })
  }
  return {
    size: processes.size,
    imageName: (pid) => processes.get(pid)?.image,
    startFileTime: (pid) => processes.get(pid)?.startFileTime,
  }
}

/**
 * A PowerShell-pillanatkép időkorlátja. Egy terheletlen gépen is lehet lassú: 2026-10-30-án egy
 * frissen beállított gépen egyedül 5,9 mp volt (az előzőn ~0,3 mp), a teljes tesztfutás terhelése
 * alatt pedig a korábbi 10 mp-et is túllépte. Az `execFile` aszinkron, a hosszabb korlát tehát semmit
 * nem tart fel, csak azt dönti el, mikor adjuk fel.
 */
export const POWERSHELL_SNAPSHOT_TIMEOUT_MS = 30_000

function runPowerShellSnapshot(): Promise<ProcessSnapshot> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: POWERSHELL_SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) reject(new Error(`PowerShell snapshot failed: ${error.message}`, { cause: error }))
        else resolve(parsePowerShellSnapshot(stdout))
      },
    )
  })
}

/**
 * Windows process probe PowerShell-lel — TARTALÉK. Az app a desktop natív (koffi) probe-ját
 * használja; ez csak akkor fut, ha az nem tölthető be.
 *
 * A `procStart` a session fájlban a process creation FILETIME decimálisan; a PowerShell
 * `StartTime.ToFileTime()` ugyanezt adja. Egyetlen pillanatképet vesz az összes processzről,
 * mert pidenként egy PowerShell indítása (~200 ms) elfogadhatatlan. Aszinkron `execFile`-lal
 * fut, így a fő szálat nem blokkolja; a TTL-t, az egyetlen futó lekérdezést és a hibakezelést
 * a `createSnapshotProbe` adja.
 */
export function createWin32ProcessProbe(ttlMs = PROBE_TTL_MS): ProcessProbe {
  return createSnapshotProbe(runPowerShellSnapshot, { ttlMs })
}
