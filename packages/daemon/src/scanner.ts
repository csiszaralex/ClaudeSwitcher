import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  type LiveSession,
  type ProcessProbe,
  type SessionActivity,
  type SessionRecord,
  type IdeLock,
  findTranscriptPath,
  ideDir,
  parseIdeLock,
  parseSessionRecord,
  readActivityFromLines,
  resolveLiveSessions,
  sessionsDir,
  tailLines,
} from '@claudeswitcher/core'

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function readRecords(claudeDir: string): Promise<SessionRecord[]> {
  const dir = sessionsDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.json'))
  const records = await Promise.all(
    names.map(async (name) => parseSessionRecord(await readJson(path.join(dir, name)))),
  )
  return records.filter((r): r is SessionRecord => r !== null)
}

async function readLocks(claudeDir: string): Promise<IdeLock[]> {
  const dir = ideDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.lock'))
  const locks = await Promise.all(
    names.map(async (name) => {
      const port = Number.parseInt(path.basename(name, '.lock'), 10)
      if (Number.isNaN(port)) return null
      return parseIdeLock(await readJson(path.join(dir, name)), port)
    }),
  )
  return locks.filter((l): l is IdeLock => l !== null)
}

/** Egy teljes állapot-pillanatkép: élő sessionök, párosított ablakok, aktivitás. */
export async function scanSessions(
  claudeDir: string,
  probe: ProcessProbe,
): Promise<{ sessions: LiveSession[]; activities: Map<string, SessionActivity> }> {
  const [records, locks] = await Promise.all([readRecords(claudeDir), readLocks(claudeDir)])
  const sessions = resolveLiveSessions(records, locks, probe)

  const entries = await Promise.all(
    sessions.map(async ({ record }): Promise<[string, SessionActivity]> => {
      try {
        const transcript = await findTranscriptPath(claudeDir, record.sessionId)
        if (transcript === undefined) return [record.sessionId, {}]
        return [record.sessionId, readActivityFromLines(await tailLines(transcript))]
      } catch (error) {
        // Védelem mélységben. A `Promise.all` egyetlen elutasításra eldobná az
        // egész szkennelést, vagyis MINDEN session eltűnne a listáról egy
        // olvashatatlan transcript miatt. A hívottak már best-effortok; ez arra
        // véd, ha egy későbbi módosítás behoz ide valami dobni képeset.
        console.error(`[scan] activity read failed for ${record.sessionId}`, error)
        return [record.sessionId, {}]
      }
    }),
  )

  return { sessions, activities: new Map(entries) }
}
