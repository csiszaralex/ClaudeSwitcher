import type { PermissionRequestInfo, PermissionRule, RuleDestination } from './decision.js'

/** A felhasználó döntése egy függő kérésről — az overlayből, IPC-n át érkezik. */
export type UserDecision =
  | { type: 'allow' }
  | { type: 'deny'; message?: string | undefined }
  | { type: 'allow-with-rules'; rules: PermissionRule[]; destination: RuleDestination }
  | { type: 'allow-session-edits' }
  | { type: 'answer'; answers: Record<string, string> }

/** A PermissionRequest hook válasza, a VSCode bővítményben mért alakban. */
export interface HookDecisionBody {
  hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: Record<string, unknown> }
}

export type DecisionResult = { ok: true; body: HookDecisionBody } | { ok: false; reason: string }

/** Három független mérés szerint a Claude Code a hookból adott terv-jóváhagyást figyelmen kívül hagyja. */
export const PLAN_APPROVAL_UNSUPPORTED =
  'Tervet a hookból nem lehet jóváhagyni (Claude Code korlát) — hagyd jóvá a VSCode-ban.'

function accept(decision: Record<string, unknown>): DecisionResult {
  return { ok: true, body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } } }
}

function refuse(reason: string): DecisionResult {
  return { ok: false, reason }
}

/** `ruleContent` nélküli szabálynál a kulcs kimarad — `undefined`-ként nem utazhat a dróton. */
function toWire(rule: PermissionRule): Record<string, string> {
  return rule.ruleContent === undefined
    ? { toolName: rule.toolName }
    : { toolName: rule.toolName, ruleContent: rule.ruleContent }
}

/**
 * A felhasználó döntéséből a hook válasza — vagy annak megtagadása, ha a döntés az adott
 * kérésre nem érvényes. Ez az egyetlen hely, ahol a spec tiltásai érvényesülnek: kérdést csak
 * válasszal, tervet soha nem enged tovább.
 */
export function buildHookResponse(request: PermissionRequestInfo, decision: UserDecision): DecisionResult {
  switch (decision.type) {
    case 'allow':
      if (request.kind === 'question') return refuse('Kérdést csak válasszal lehet továbbengedni.')
      if (request.kind === 'plan') return refuse(PLAN_APPROVAL_UNSUPPORTED)
      return accept({ behavior: 'allow' })

    case 'deny': {
      const message = decision.message?.trim() ?? ''
      if (request.kind === 'plan' && message === '') {
        return refuse('A terv elutasításához visszajelzés kell — abból tervez újra a session.')
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
      // Üres lista = a kérdéseket nem tudtuk kiolvasni (megváltozott `tool_input` alak). A
      // kérdésenkénti ellenőrzés ilyenkor semmit nem utasítana el, és egy válasz nélküli `allow`
      // menne ki — épp az, amit a spec tilt. Innen csak a VSCode vagy egy tiltás vezet tovább.
      if (request.questions.length === 0) {
        return refuse('A kérdéseket nem sikerült kiolvasni — válaszolj a VSCode-ban.')
      }
      // A válasz kulcsai pontosan a kérdések szövegei: egy idegen kulcs olyan választ jelentene,
      // amit a felhasználó nem az itt látott kérdésre adott.
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

/** Többválasztós válasz a dokumentált formában (a tömb „Other"-ként jelent meg — spike R1a). */
export function joinAnswerLabels(labels: readonly string[]): string {
  return labels.join(', ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
 * Egy IPC-n érkezett döntés ellenőrzése. A renderer bármit küldhet; ami nem pontosan egy
 * `UserDecision`, azt elutasítjuk, mielőtt a daemonhoz érne. Soha nem dob.
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
