import { execFileSync } from 'node:child_process'
import type { IdeLock, LiveSession, SessionRecord } from './types.js'

export interface ProcessProbe {
  /**
   * Igaz, ha a pid létezik ÉS — ha `procStart` meg van adva — a process
   * indulási ideje egyezik. A pid önmagában nem elég: a Windows újrahasznosítja
   * a pideket, és az elárvult lock fájlok miatt rossz ablakra ugranánk.
   */
  isAlive(pid: number, procStart?: string): boolean
}

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Igaz, ha `child` azonos `parent`-tel vagy alatta van. */
function isWithin(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(p + '\\')
}

function bestWindow(cwd: string, locks: IdeLock[], probe: ProcessProbe): IdeLock | undefined {
  let best: IdeLock | undefined
  let bestLength = -1

  for (const lock of locks) {
    if (!probe.isAlive(lock.pid)) continue
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
  '  try { "$($_.Id) $($_.StartTime.ToFileTime())" } catch { }',
  '}',
].join(' ')

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
  let snapshot = new Map<number, string>()
  let takenAt = 0

  function refresh(): void {
    const now = Date.now()
    if (now - takenAt < ttlMs) return
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

    const next = new Map<number, string>()
    for (const line of output.split('\n')) {
      const [rawPid, fileTime] = line.trim().split(' ')
      if (rawPid === undefined || fileTime === undefined) continue
      const pid = Number.parseInt(rawPid, 10)
      if (!Number.isNaN(pid)) next.set(pid, fileTime)
    }
    if (next.size > 0) snapshot = next
  }

  return {
    isAlive(pid, procStart) {
      refresh()
      const startFileTime = snapshot.get(pid)
      if (startFileTime === undefined) return false
      if (procStart === undefined) return true
      return startFileTime === procStart
    },
  }
}
