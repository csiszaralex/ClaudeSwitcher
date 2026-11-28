import type { DecisionKind, UserDecision } from '@claudeswitcher/core'
import { sandboxDisabled } from './sandbox.js'

/**
 * The per-session auto-accept mode: which requests it allows by itself, with which decision, and
 * the wire format of the sessions in the mode. The main process applies it (`main/auto-accept.ts`),
 * the overlay shows it and turns it on and off (`renderer/auto-accept-hold.ts`). Compiled by both
 * the main and the renderer projects, so it imports no `node:` module.
 */

/**
 * The plain allow: what the decision panel's allow button sends (`renderer/DecisionPanel.tsx`), and
 * the one decision the auto-accept mode ever gives. Never a rule and never `allow-session-edits`.
 */
export const ALLOW_DECISION: UserDecision = { type: 'allow' }

/** The part of a pending request the mode reads; the daemon's `PendingDecisionView` fits it. */
export interface AutoAcceptRequest {
  kind: DecisionKind
  /** False when the request's input could not be read (core `decision.ts` `PermissionRequestInfo.readable`). */
  readable: boolean
  /** Released by the app (`PERMISSION_RELEASE_AFTER_MS`): only the session's own prompt can decide it. */
  released: boolean
  toolInput: unknown
}

/**
 * Whether the mode allows this request by itself: exactly what the panel's plain allow button would
 * allow (a command or a tool, `tool`, and a file write, `edit`; the kinds whose button row has it,
 * `renderer/decision-actions.ts` `ACTION_BUTTONS`, which its test checks), and of those never an
 * unreadable request, a released one, or a command that turns off the sandbox (`sandboxDisabled`).
 * A question or a plan always waits for the user. An exhaustive switch over core's `DecisionKind`,
 * so a new kind must be classified here.
 */
export function autoAcceptTakes(request: AutoAcceptRequest): boolean {
  if (!request.readable || request.released || sandboxDisabled(request.toolInput)) return false
  switch (request.kind) {
    case 'tool':
    case 'edit':
      return true
    case 'question':
    case 'plan':
      return false
  }
}

/**
 * One session in the mode, on the wire: its id and how many requests the mode allowed since the
 * user's last own prompt to the session, or since it was turned on when that is later
 * (`main/auto-accept.ts` `observe`).
 */
export interface AutoAcceptEntry {
  sessionId: string
  allowed: number
}
