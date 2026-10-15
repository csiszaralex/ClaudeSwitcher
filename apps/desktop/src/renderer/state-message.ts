import type { RateLimits, SessionView } from '@claudeswitcher/core'
import type { PendingDecisionView } from '@claudeswitcher/daemon'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
  decisions: PendingDecisionView[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const DECISION_KINDS = new Set(['tool', 'edit', 'question', 'plan'])

function isQuestion(value: unknown): boolean {
  if (!isObject(value)) return false
  const options = value['options']
  return (
    typeof value['question'] === 'string' &&
    typeof value['multiSelect'] === 'boolean' &&
    Array.isArray(options) &&
    options.every((option: unknown) => isObject(option) && typeof option['label'] === 'string')
  )
}

/**
 * Egy függő döntés a daemontól. Csak azt engedjük át, amit a panel biztonságosan meg tud
 * jeleníteni: egy hibás elem itt csendben kiesik, ahelyett hogy a renderelésnél dobna, és az
 * ErrorBoundary miatt az egész overlayt hibaszövegbe fagyasztaná.
 */
function isDecision(value: unknown): value is PendingDecisionView {
  if (!isObject(value)) return false
  const kind = value['kind']
  const questions = value['questions']
  const rules = value['suggestedRules']
  return (
    typeof value['id'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    typeof value['summary'] === 'string' &&
    typeof value['released'] === 'boolean' &&
    typeof kind === 'string' &&
    DECISION_KINDS.has(kind) &&
    Array.isArray(questions) &&
    questions.every(isQuestion) &&
    Array.isArray(rules) &&
    rules.every((rule: unknown) => isObject(rule) && typeof rule['toolName'] === 'string')
  )
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

  const sessions = payload['sessions']
  const rateLimits = payload['rateLimits']
  const decisions = payload['decisions']
  if (!Array.isArray(sessions)) return undefined
  if (!isObject(rateLimits)) return undefined

  return {
    sessions: sessions.filter(
      (view: unknown): view is SessionView => isObject(view) && typeof view['sessionId'] === 'string',
    ),
    // A `five_hour !== undefined` vizsgálat egy `null`-ra IGAZ, az App pedig utána a
    // `.used_percentage`-en dobna. Itt kiszűrve a megjelenítésnek nem kell erre gondolnia.
    rateLimits: Object.fromEntries(Object.entries(rateLimits).filter(([, window]) => isObject(window))),
    // Egy régebbi daemon nem küld döntéseket — az nem hiba, hanem „nincs függő döntés".
    decisions: Array.isArray(decisions) ? decisions.filter(isDecision) : [],
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
  if (message['type'] === 'tick') return { kind: 'tick' }
  if (message['type'] !== 'state') return undefined
  const state = sanitizeState(message['payload'])
  return state === undefined ? undefined : { kind: 'state', state }
}

/** Egy WebSocket üzenetből kiolvassa az állapotot, vagy `undefined`-ot ad. Soha nem dob. */
export function parseStateMessage(data: unknown): DaemonState | undefined {
  const parsed = parseDaemonMessage(data)
  return parsed?.kind === 'state' ? parsed.state : undefined
}
