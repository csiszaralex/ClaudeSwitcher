import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createWin32ProcessProbe, resolveClaudeDir } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
import { takeNativeSnapshot } from './process-probe.js'

/**
 * Egyszeri, kézzel indított mérés ezen a gépen: `CS_PROBE_MEASURE=1 vitest run process-probe.measure`.
 * Csak olvas — semmilyen processzt nem állít le és nem jelez. Egy PowerShell pillanatképet
 * is vesz összehasonlításnak; az az appon kívül, egyszer fut, ezért elfogadható.
 */
const enabled = process.env['CS_PROBE_MEASURE'] === '1'

interface RegistryEntry {
  pid: number
  procStart?: string | undefined
}

async function readPids(dir: string, ext: string): Promise<RegistryEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: RegistryEntry[] = []
  for (const name of names.filter((n) => n.endsWith(ext))) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
      if (typeof raw !== 'object' || raw === null || !('pid' in raw) || typeof raw.pid !== 'number') continue
      const procStart = 'procStart' in raw && typeof raw.procStart === 'string' ? raw.procStart : undefined
      out.push({ pid: raw.pid, procStart })
    } catch {
      // Olvashatatlan fájl: kimarad.
    }
  }
  return out
}

describe.runIf(enabled)('native probe measurement (manual)', () => {
  it('times the native snapshot and agrees with PowerShell on the registry pids', async () => {
    const claudeDir = resolveClaudeDir()
    const sessions = await readPids(path.join(claudeDir, 'sessions'), '.json')
    const locks = await readPids(path.join(claudeDir, 'ide'), '.lock')

    const runs: number[] = []
    const listOnly: number[] = []
    let native = takeNativeSnapshot()
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      native = takeNativeSnapshot()
      const t1 = performance.now()
      for (const s of sessions) native?.startFileTime(s.pid)
      runs.push(performance.now() - t0)
      listOnly.push(t1 - t0)
    }
    expect(native).toBeDefined()

    const psStart = performance.now()
    const ps = createWin32ProcessProbe()
    await ps.refresh()
    const psMs = performance.now() - psStart

    const nativeAlive = (pid: number, procStart?: string): boolean =>
      native?.imageName(pid) !== undefined &&
      (procStart === undefined || native.startFileTime(pid) === procStart)

    const rows = [...sessions, ...locks.map((l) => ({ pid: l.pid, procStart: undefined }))].map((e) => ({
      pid: e.pid,
      registry: e.procStart !== undefined,
      nativeAlive: nativeAlive(e.pid, e.procStart),
      psAlive: ps.isAlive(e.pid, e.procStart),
      nativeStart: native?.startFileTime(e.pid),
      procStart: e.procStart,
      nativeImage: native?.imageName(e.pid),
      psImage: ps.imageName(e.pid),
    }))

    console.log(
      JSON.stringify(
        {
          processes: native?.size,
          sessionPids: sessions.length,
          lockPids: locks.length,
          nativeMs: runs.map((ms) => Math.round(ms * 100) / 100),
          nativeListOnlyMs: listOnly.map((ms) => Math.round(ms * 100) / 100),
          powershellMs: Math.round(psMs),
        },
        null,
        2,
      ),
    )
    console.table(rows)

    for (const row of rows) {
      expect(row.nativeAlive, `alive ${String(row.pid)}`).toBe(row.psAlive)
      // Csak az élő pideknél van mit összevetni; a PowerShell a halottakat nem listázza.
      if (row.psAlive) expect(row.nativeImage, `image ${String(row.pid)}`).toBe(row.psImage)
    }
  }, 60_000)
})
