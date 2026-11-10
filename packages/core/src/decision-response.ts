import type { PermissionRequestInfo, PermissionRule, RuleDestination } from './decision.js'
import { isRecord } from './guards.js'

/** The user's decision on a pending request: it comes from the overlay, over IPC. */
export type UserDecision =
  | { type: 'allow' }
  | { type: 'deny'; message?: string | undefined }
  | { type: 'allow-with-rules'; rules: PermissionRule[]; destination: RuleDestination }
  | { type: 'allow-session-edits' }
  | { type: 'answer'; answers: Record<string, string> }

/** The PermissionRequest hook's response, in the shape measured with the VS Code extension. */
export interface HookDecisionBody {
  hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: Record<string, unknown> }
}

export type DecisionResult = { ok: true; body: HookDecisionBody } | { ok: false; reason: string }

/** Three independent measurements showed that Claude Code ignores a plan approval given by the hook. */
export const PLAN_APPROVAL_UNSUPPORTED =
  'Tervet a hookból nem lehet jóváhagyni (Claude Code korlát). Hagyd jóvá a VSCode-ban.'

/**
 * For an unreadable request (`PermissionRequestInfo.readable`) the panel sees only the tool name,
 * so an allow would go out blind. The panel shows this same text in place of the buttons.
 */
export const UNREADABLE_REQUEST =
  'A kérés tartalma nem olvasható (ismeretlen formátum), ezért itt nem engedélyezhető. Tilthatod, vagy dönts a VSCode-ban.'

function accept(decision: Record<string, unknown>): DecisionResult {
  return { ok: true, body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } } }
}

function refuse(reason: string): DecisionResult {
  return { ok: false, reason }
}

/** A rule without `ruleContent` leaves the key out: it cannot travel on the wire as `undefined`. */
function toWire(rule: PermissionRule): Record<string, string> {
  return rule.ruleContent === undefined
    ? { toolName: rule.toolName }
    : { toolName: rule.toolName, ruleContent: rule.ruleContent }
}

/**
 * The hook response built from the user's decision, or a refusal when the decision is not valid
 * for the request. This is the one place that enforces the design's bans: a question goes through
 * only with an answer, a plan never, and an unreadable request can only be denied.
 */
export function buildHookResponse(request: PermissionRequestInfo, decision: UserDecision): DecisionResult {
  if (!request.readable && decision.type !== 'deny') return refuse(UNREADABLE_REQUEST)
  switch (decision.type) {
    case 'allow':
      if (request.kind === 'question') return refuse('Kérdést csak válasszal lehet továbbengedni.')
      if (request.kind === 'plan') return refuse(PLAN_APPROVAL_UNSUPPORTED)
      return accept({ behavior: 'allow' })

    case 'deny': {
      const message = decision.message?.trim() ?? ''
      if (request.kind === 'plan' && message === '') {
        return refuse('A terv elutasításához visszajelzés kell, abból tervez újra a session.')
      }
      return accept(message === '' ? { behavior: 'deny' } : { behavior: 'deny', message })
    }

    case 'allow-with-rules':
      if (request.kind !== 'tool') return refuse('Szabályt csak parancsra, WebFetch-re vagy MCP-toolra lehet felvenni.')
      if (decision.rules.length === 0) return refuse('Legalább egy szabály kell.')
      return accept({
        behavior: 'allow',
        updatedPermissions: [
          { type: 'addRules', rules: decision.rules.map(toWire), behavior: 'allow', destination: decision.destination },
        ],
      })

    case 'allow-session-edits':
      if (request.kind !== 'edit') return refuse('Automatikus szerkesztés csak fájlírásnál kérhető.')
      return accept({
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      })

    case 'answer': {
      if (request.kind !== 'question') return refuse('Válasz csak kérdésre adható.')
      // An empty list means the questions could not be read (a changed `tool_input` shape). The
      // per-question check would then refuse nothing, and an `allow` without answers would go out:
      // exactly what the design forbids. From here only VS Code or a deny leads on.
      if (request.questions.length === 0) {
        return refuse('A kérdéseket nem sikerült kiolvasni. Válaszolj a VSCode-ban.')
      }
      // The answer keys are exactly the question texts: a foreign key would be an answer the user
      // did not give to a question shown here.
      const texts = new Set(request.questions.map((question) => question.question))
      for (const key of Object.keys(decision.answers)) {
        if (!texts.has(key)) return refuse(`Nincs ilyen kérdés: „${key}"`)
      }
      for (const question of request.questions) {
        if ((decision.answers[question.question] ?? '').trim() === '') {
          return refuse(`Hiányzik a válasz: „${question.question}"`)
        }
      }
      return accept({ behavior: 'allow', updatedInput: { ...request.toolInput, answers: decision.answers } })
    }
  }
}

/** A multiple-choice answer in the documented form (an array showed up as "Other", spike R1a). */
export function joinAnswerLabels(labels: readonly string[]): string {
  return labels.join(', ')
}

function parseRule(raw: unknown): PermissionRule | undefined {
  if (!isRecord(raw)) return undefined
  const toolName = raw['toolName']
  const ruleContent = raw['ruleContent']
  if (typeof toolName !== 'string' || toolName === '') return undefined
  if (ruleContent === undefined) return { toolName }
  return typeof ruleContent === 'string' ? { toolName, ruleContent } : undefined
}

/**
 * Validates a decision that arrived over IPC. The renderer may send anything; whatever is not
 * exactly a `UserDecision` is rejected before it reaches the daemon. Never throws.
 */
export function parseUserDecision(raw: unknown): UserDecision | undefined {
  if (!isRecord(raw)) return undefined
  switch (raw['type']) {
    case 'allow':
      return { type: 'allow' }
    case 'allow-session-edits':
      return { type: 'allow-session-edits' }
    case 'deny': {
      const message = raw['message']
      if (message === undefined) return { type: 'deny' }
      return typeof message === 'string' ? { type: 'deny', message } : undefined
    }
    case 'allow-with-rules': {
      const destination = raw['destination']
      const list = raw['rules']
      if (destination !== 'localSettings' && destination !== 'userSettings') return undefined
      if (!Array.isArray(list)) return undefined
      const rules: PermissionRule[] = []
      for (const item of list) {
        const rule = parseRule(item)
        if (rule === undefined) return undefined
        rules.push(rule)
      }
      return { type: 'allow-with-rules', destination, rules }
    }
    case 'answer': {
      const answers = raw['answers']
      if (!isRecord(answers)) return undefined
      const clean: Record<string, string> = {}
      for (const [question, answer] of Object.entries(answers)) {
        if (typeof answer !== 'string') return undefined
        clean[question] = answer
      }
      return { type: 'answer', answers: clean }
    }
    default:
      return undefined
  }
}
