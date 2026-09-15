import type { RateLimits, SessionView } from '@claudeswitcher/core'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
}

/** Egy WebSocket üzenetből kiolvassa az állapotot, vagy `undefined`-ot ad. Soha nem dob. */
export function parseStateMessage(data: unknown): DaemonState | undefined {
  let message: unknown
  try {
    message = JSON.parse(String(data))
  } catch {
    return undefined
  }
  if (typeof message !== 'object' || message === null) return undefined

  const { type, payload } = message as { type?: unknown; payload?: unknown }
  if (type !== 'state' || typeof payload !== 'object' || payload === null) return undefined

  const { sessions, rateLimits } = payload as { sessions?: unknown; rateLimits?: unknown }
  if (!Array.isArray(sessions)) return undefined
  if (typeof rateLimits !== 'object' || rateLimits === null) return undefined

  return payload as DaemonState
}
