import type { IdeLock, SessionRecord } from './types.js'
import { isRecord } from './guards.js'

/**
 * Tolerant parse: ignores unknown fields and returns null when a required field is missing. Never
 * throws: the format is undocumented and may change between versions, and one bad file must not
 * take the other sessions down with it.
 */
export function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (!isRecord(raw)) return null
  const { pid, sessionId, cwd, startedAt } = raw
  if (typeof pid !== 'number' || typeof sessionId !== 'string') return null
  if (typeof cwd !== 'string' || typeof startedAt !== 'number') return null

  return {
    pid,
    sessionId,
    cwd,
    startedAt,
    procStart: typeof raw['procStart'] === 'string' ? raw['procStart'] : undefined,
    entrypoint: typeof raw['entrypoint'] === 'string' ? raw['entrypoint'] : undefined,
    name: typeof raw['name'] === 'string' ? raw['name'] : undefined,
    bridgeSessionId:
      typeof raw['bridgeSessionId'] === 'string' ? raw['bridgeSessionId']
      : raw['bridgeSessionId'] === null ? null
      : undefined,
    // An unknown `status` text passes through unchanged (see `SessionRecord`).
    status: typeof raw['status'] === 'string' ? raw['status'] : undefined,
    waitingFor:
      typeof raw['waitingFor'] === 'string' ? raw['waitingFor']
      : raw['waitingFor'] === null ? null
      : undefined,
    statusUpdatedAt: typeof raw['statusUpdatedAt'] === 'number' ? raw['statusUpdatedAt'] : undefined,
  }
}

export function parseIdeLock(raw: unknown, port: number): IdeLock | null {
  if (!isRecord(raw)) return null
  const { pid, workspaceFolders } = raw
  if (typeof pid !== 'number' || !Array.isArray(workspaceFolders)) return null
  const folders = workspaceFolders.filter((f): f is string => typeof f === 'string')
  if (folders.length === 0) return null

  return {
    port,
    pid,
    workspaceFolders: folders,
    ideName: typeof raw['ideName'] === 'string' ? raw['ideName'] : undefined,
  }
}
