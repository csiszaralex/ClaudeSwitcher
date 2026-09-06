import { execFileSync } from 'node:child_process'
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
   * ha a pid nem él. A lock fájlok nem tárolnak `procStart`-ot, így náluk ez az
   * egyetlen fogódzó annak eldöntésére, hogy a pid tényleg a bejegyzett IDE-hez
   * tartozik-e, vagy időközben újrahasznosították.
   */
  imageName(pid: number): string | undefined
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
 * Igaz, ha a lock pidje tényleg az a fajta processz, aminek a lock mondja.
 *
 * A veszélyes eset, ami ellen véd: egy elárvult lock ugyanarra a workspace-re,
 * aminek a pidjét időközben egy független processz kapta meg. A pid él, az
 * útvonal egyezik — csak az image név árulja el, hogy nem VSCode ablak. Ismeretlen
 * IDE-nél nem szűrünk: inkább párosítunk, mint hogy egy támogatott szerkesztőt
 * kizárjunk egy tipp alapján.
 */
function ownsLock(lock: IdeLock, probe: ProcessProbe): boolean {
  const image = probe.imageName(lock.pid)
  if (image === undefined) return false
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

const SNAPSHOT_SCRIPT = [
  'Get-Process | ForEach-Object {',
  '  try { "$($_.Id)`t$($_.StartTime.ToFileTime())`t$($_.Name)" } catch { }',
  '}',
].join(' ')

interface ProcessInfo {
  startFileTime: string
  image: string
}

/**
 * Windows process probe. A `procStart` a session fájlban a process creation
 * FILETIME decimálisan; a PowerShell `StartTime.ToFileTime()` ugyanezt adja.
 *
 * Egyetlen pillanatképet vesz az összes processzről, és abból válaszol. Ez
 * szándékos: egy szkennelés 20-30 pidet kérdez meg, és pidenként egy
 * PowerShell indítása (~200 ms) a másodperces poll mellett elfogadhatatlan.
 * A pillanatkép `ttlMs`-ig érvényes, és hiba esetén az előzőt tartjuk meg —
 * egy elbukott lekérdezés ne tüntesse el az összes sessiont a listáról.
 */
export function createWin32ProcessProbe(ttlMs = 2000): ProcessProbe {
  let snapshot = new Map<number, ProcessInfo>()
  let takenAt = 0
  let primed = false

  function refresh(): void {
    const now = Date.now()
    // Amíg egyszer sem sikerült, sűrűbben próbálkozunk: az üres pillanatkép
    // minden sessiont halottnak mutatna, és a teljes TTL-t végigvárni ezzel a
    // hazugsággal rosszabb, mint egy gyors újrapróbálkozás.
    const interval = primed ? ttlMs : Math.min(ttlMs, 250)
    if (now - takenAt < interval) return
    takenAt = now

    let output: string
    try {
      output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      )
    } catch (error) {
      console.error('[probe] process snapshot failed, keeping the previous one', error)
      return
    }

    const next = new Map<number, ProcessInfo>()
    for (const line of output.split('\n')) {
      const [rawPid, startFileTime, image] = line.trim().split('\t')
      if (rawPid === undefined || startFileTime === undefined || image === undefined) continue
      const pid = Number.parseInt(rawPid, 10)
      if (!Number.isNaN(pid)) next.set(pid, { startFileTime, image })
    }
    if (next.size > 0) {
      snapshot = next
      primed = true
    }
  }

  return {
    isAlive(pid, procStart) {
      refresh()
      const proc = snapshot.get(pid)
      if (proc === undefined) return false
      if (procStart === undefined) return true
      return proc.startFileTime === procStart
    },
    imageName(pid) {
      refresh()
      return snapshot.get(pid)?.image
    },
  }
}
