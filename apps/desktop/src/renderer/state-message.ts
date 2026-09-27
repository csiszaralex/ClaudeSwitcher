import type { RateLimits, SessionView } from '@claudeswitcher/core'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Megtisztít egy állapot-payloadot, vagy `undefined`-ot ad. Soha nem dob.
 *
 * MINDKÉT szállítási út ezen megy át — a WebSocket üzenet és az IPC-n kért kezdőállapot is.
 * Ez a lényeg: a kezdőállapot nem a WebSocketen jön, tehát ha csak a `parseStateMessage`
 * szűrne, az IPC-s út továbbra is beengedne hibás alakot.
 *
 * Az ELEMEKET is szűri, nem csak a konténereket. Egy `sessions: [null]` egy puszta
 * `Array.isArray` ellenőrzésen túljutna, az App pedig a `view.sessionId`-n dobna — és mivel
 * az ErrorBoundary nem áll vissza magától, az overlay onnantól véglegesen hibaszöveget
 * mutatna. Egy rossz alakú elemet inkább eldobunk, mint hogy az egész listát elveszítsük.
 */
export function sanitizeState(payload: unknown): DaemonState | undefined {
  if (!isObject(payload)) return undefined

  const { sessions, rateLimits } = payload
  if (!Array.isArray(sessions)) return undefined
  if (!isObject(rateLimits)) return undefined

  return {
    sessions: sessions.filter(
      (view): view is SessionView =>
        isObject(view) && typeof (view as { sessionId?: unknown }).sessionId === 'string',
    ),
    // A `five_hour !== undefined` vizsgálat egy `null`-ra IGAZ, az App pedig utána a
    // `.used_percentage`-en dobna. Itt kiszűrve a megjelenítésnek nem kell erre gondolnia.
    rateLimits: Object.fromEntries(
      Object.entries(rateLimits).filter(([, window]) => isObject(window)),
    ) as RateLimits,
  }
}

/** Amit a daemontól érthetünk: egy új állapot, vagy egy életjel. */
export type DaemonMessage = { kind: 'state'; state: DaemonState } | { kind: 'tick' }

/**
 * Egy WebSocket üzenet értelmezése, vagy `undefined`. Soha nem dob.
 *
 * A `tick` azért kell, mert a daemon nem küldi újra az azonos pillanatképet: nélküle a
 * kliens nem tudná megkülönböztetni azt, hogy „él, de nincs változás", attól, hogy „megállt".
 */
export function parseDaemonMessage(data: unknown): DaemonMessage | undefined {
  let message: unknown
  try {
    message = JSON.parse(String(data))
  } catch {
    return undefined
  }
  if (!isObject(message)) return undefined
  if (message.type === 'tick') return { kind: 'tick' }
  if (message.type !== 'state') return undefined
  const state = sanitizeState(message.payload)
  return state === undefined ? undefined : { kind: 'state', state }
}

/** Egy WebSocket üzenetből kiolvassa az állapotot, vagy `undefined`-ot ad. Soha nem dob. */
export function parseStateMessage(data: unknown): DaemonState | undefined {
  const parsed = parseDaemonMessage(data)
  return parsed?.kind === 'state' ? parsed.state : undefined
}
