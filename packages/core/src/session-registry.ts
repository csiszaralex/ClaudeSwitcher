import type { IdeLock, SessionRecord } from './types.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Toleráns parse: ismeretlen mezőket figyelmen kívül hagy, hiányzó kötelező
 * mezőnél null-t ad. Soha nem dob — a formátum nem dokumentált, verzióváltásnál
 * változhat, és egy rossz fájl nem viheti magával a többi sessiont.
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
    version: typeof raw['version'] === 'string' ? raw['version'] : undefined,
    kind: typeof raw['kind'] === 'string' ? raw['kind'] : undefined,
    entrypoint: typeof raw['entrypoint'] === 'string' ? raw['entrypoint'] : undefined,
    name: typeof raw['name'] === 'string' ? raw['name'] : undefined,
    bridgeSessionId:
      typeof raw['bridgeSessionId'] === 'string' ? raw['bridgeSessionId']
      : raw['bridgeSessionId'] === null ? null
      : undefined,
    // Ismeretlen `status` szöveget változatlanul átengedünk (lásd a SessionRecord-ot).
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
    transport: typeof raw['transport'] === 'string' ? raw['transport'] : undefined,
  }
}
