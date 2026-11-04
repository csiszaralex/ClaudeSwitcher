import type { SessionView, SubagentView } from '@claudeswitcher/core'
import type { DaemonState, PendingDecisionView } from '@claudeswitcher/daemon'
import { DAEMON_PROTOCOL, isDecisionKind, isRecord } from '@claudeswitcher/core/browser'

function isQuestion(value: unknown): boolean {
  if (!isRecord(value)) return false
  const options = value['options']
  return (
    typeof value['question'] === 'string' &&
    typeof value['multiSelect'] === 'boolean' &&
    Array.isArray(options) &&
    options.every((option: unknown) => isRecord(option) && typeof option['label'] === 'string')
  )
}

/**
 * Egy függő döntés a daemontól. Csak azt engedjük át, amit a panel biztonságosan meg tud
 * jeleníteni: egy hibás elem itt csendben kiesik, ahelyett hogy a renderelésnél dobna, és az
 * ErrorBoundary miatt az egész overlayt hibaszövegbe fagyasztaná.
 */
function isDecision(value: unknown): value is PendingDecisionView {
  if (!isRecord(value)) return false
  const questions = value['questions']
  const rules = value['suggestedRules']
  return (
    typeof value['id'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    typeof value['summary'] === 'string' &&
    // Opcionális a `PermissionRequestInfo`-ban: nincs, ha az eszköz nem ad leírást. Ha jön, szövegnek kell lennie, a panel annak rendereli.
    optionalString(value['description']) &&
    typeof value['released'] === 'boolean' &&
    // Kötelező: ebből dönti el a panel, kínál-e engedélyezést. Hiányzó jelző nem számíthat olvashatónak.
    typeof value['readable'] === 'boolean' &&
    isDecisionKind(value['kind']) &&
    Array.isArray(questions) &&
    questions.every(isQuestion) &&
    Array.isArray(rules) &&
    rules.every((rule: unknown) => isRecord(rule) && typeof rule['toolName'] === 'string')
  )
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/**
 * Egy aktív subagent a daemontól. Szigorú: egy rossz típusú mező a sor szövegébe `[object Object]`-et
 * vagy számot írna, és a hiányzó kötelező mező (`agentId`, `updatedAt`) hibás alakot jelez.
 * Mint a többi mezőnél: a hibás session kiesik, nem a renderelés dob.
 */
function isSubagent(value: unknown): value is SubagentView {
  return (
    isRecord(value) &&
    typeof value['agentId'] === 'string' &&
    typeof value['updatedAt'] === 'number' &&
    optionalString(value['agentType']) &&
    optionalString(value['description']) &&
    optionalString(value['runningTool']) &&
    optionalString(value['toolDetail'])
  )
}

/**
 * Megtisztít egy állapot-payloadot, vagy `undefined`-ot ad. Soha nem dob.
 *
 * MINDKÉT szállítási út ezen megy át: a WebSocket üzenet és az IPC-n kért kezdőállapot is.
 * Ez a lényeg: a kezdőállapot nem a WebSocketen jön, tehát ha csak a `parseStateMessage`
 * szűrne, az IPC-s út továbbra is beengedne hibás alakot.
 *
 * Az ELEMEKET is szűri, nem csak a konténereket. Egy `sessions: [null]` egy puszta
 * `Array.isArray` ellenőrzésen túljutna, az App pedig a `view.sessionId`-n dobna, és mivel
 * az ErrorBoundary nem áll vissza magától, az overlay onnantól véglegesen hibaszöveget
 * mutatna. Egy rossz alakú elemet inkább eldobunk, mint hogy az egész listát elveszítsük.
 */
export function sanitizeState(payload: unknown): DaemonState | undefined {
  if (!isRecord(payload)) return undefined

  const sessions = payload['sessions']
  const decisions = payload['decisions']
  if (!Array.isArray(sessions)) return undefined

  return {
    sessions: sessions.filter(
      (view: unknown): view is SessionView =>
        isRecord(view) &&
        typeof view['sessionId'] === 'string' &&
        // Opcionális a `SessionView`-ban: csak az „épp végzett" sessionnél van. Ha jön, számnak kell lennie, időt számolnak belőle.
        (view['stoppedAt'] === undefined || typeof view['stoppedAt'] === 'number') &&
        // Opcionális: a registry rekordjából jön, ha ott van. Ha jön, szöveg, a nyers `entrypoint` érték.
        optionalString(view['entrypoint']) &&
        // Opcionális: csak aktív subagent mellett van. Ha jön, minden eleme olyan alakú, amit a sor összefoglalója olvas.
        (view['subagents'] === undefined || (Array.isArray(view['subagents']) && view['subagents'].every(isSubagent))),
    ),
    // A daemon mindig küldi; a hiánya itt sem dobja el a sessionöket, hanem „nincs függő döntés".
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
  // Más protokollverzió (vagy hiányzó) üzenetét nem értelmezzük: az alakja eltérhet attól, amit itt olvasunk.
  if (!isRecord(message) || message['protocol'] !== DAEMON_PROTOCOL) return undefined
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
