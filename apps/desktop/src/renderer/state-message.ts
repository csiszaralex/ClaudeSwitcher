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
 * A pending decision from the daemon. Only what the panel can safely display gets through: a bad
 * element silently drops out here instead of throwing at render time, where an ErrorBoundary would
 * replace the panel or the whole overlay with an error text.
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
    // Optional in `PermissionRequestInfo`: absent when the tool gives no description. If present it
    // must be a string, the panel renders it as one.
    optionalString(value['description']) &&
    typeof value['released'] === 'boolean' &&
    // Required: from it the panel decides whether to offer allowing. A missing flag must not count as readable.
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
 * An active subagent from the daemon. Strict: a field of the wrong type would write `[object Object]`
 * or a number into the row text, and a missing required field (`agentId`, `updatedAt`) signals a
 * bad shape. As with the other fields: the bad session drops out, the render does not throw.
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
 * Cleans a state payload, or returns `undefined`. Never throws.
 *
 * BOTH transport paths go through this: the WebSocket message and the initial state requested over
 * IPC. That is the point: the initial state does not come over the WebSocket, so if only
 * `parseDaemonMessage` filtered, the IPC path would still let a bad shape in.
 *
 * It filters the ELEMENTS too, not just the containers. A `sessions: [null]` would pass a bare
 * `Array.isArray` check, App would throw on `view.sessionId`, and the ErrorBoundary would show an
 * error text instead of the list until a state without the bad element arrives. Dropping one
 * malformed element is better than losing the whole list.
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
        // Optional in `SessionView`: present only on a session that "just finished" (session-marker.ts
        // `statusMarker` reads it). If present it must be a number, the time the type declares.
        (view['stoppedAt'] === undefined || typeof view['stoppedAt'] === 'number') &&
        // Optional: comes from the registry record when it is there. If present, a string, the raw
        // `entrypoint` value.
        optionalString(view['entrypoint']) &&
        // Optional: present only with an active subagent. If present, every element has the shape
        // the row summary reads.
        (view['subagents'] === undefined || (Array.isArray(view['subagents']) && view['subagents'].every(isSubagent))),
    ),
    // The daemon always sends it; its absence does not drop the sessions either, it means "no pending decision".
    decisions: Array.isArray(decisions) ? decisions.filter(isDecision) : [],
  }
}

/** What the daemon can tell us: a new state, or a heartbeat. */
export type DaemonMessage = { kind: 'state'; state: DaemonState } | { kind: 'tick' }

/**
 * Parses a WebSocket message, or returns `undefined`. Never throws.
 *
 * The `tick` is needed because the daemon does not resend an identical snapshot: without it the
 * client could not tell "alive, but no change" from "stopped".
 */
export function parseDaemonMessage(data: unknown): DaemonMessage | undefined {
  let message: unknown
  try {
    message = JSON.parse(String(data))
  } catch {
    return undefined
  }
  // A message with another (or no) protocol version is not parsed: its shape may differ from what is read here.
  if (!isRecord(message) || message['protocol'] !== DAEMON_PROTOCOL) return undefined
  if (message['type'] === 'tick') return { kind: 'tick' }
  if (message['type'] !== 'state') return undefined
  const state = sanitizeState(message['payload'])
  return state === undefined ? undefined : { kind: 'state', state }
}

/** Reads the state from a WebSocket message, or returns `undefined`. Never throws. */
export function parseStateMessage(data: unknown): DaemonState | undefined {
  const parsed = parseDaemonMessage(data)
  return parsed?.kind === 'state' ? parsed.state : undefined
}
