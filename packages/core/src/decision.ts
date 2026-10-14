/**
 * A PermissionRequest hook bemenetének értelmezése. Tiszta függvények, IO nélkül.
 *
 * A bemenet alakja a VSCode bővítményben MÉRVE (spikes/m2-permission/RESULTS.md), nem a
 * dokumentációból: a tesztek a packages/core/fixtures/hook-payloads.json valódi törzseit
 * használják.
 */

/** Egy jogosultsági szabály, ahogy a Claude Code `permission_suggestions`-ben adja. */
export interface PermissionRule {
  toolName: string
  /** Pl. `echo spike-a *`. MCP-toolnál nincs: ott a szabály maga a tool neve. */
  ruleContent?: string | undefined
}

/** Hova írja a Claude Code a szabályt: a projekt helyi beállításaiba, vagy a gépszintűbe. */
export type RuleDestination = 'localSettings' | 'userSettings'

export interface AskOption {
  label: string
  description?: string | undefined
}

export interface AskQuestion {
  question: string
  header?: string | undefined
  multiSelect: boolean
  options: AskOption[]
}

/**
 * Mit kínál az overlay a kérésre (spec §5 táblázata):
 * - `tool`: parancs, WebFetch, MCP — engedélyez / tilt / projekt- vagy gépszintű szabály
 * - `edit`: fájlírás — engedélyez / tilt / erre a sessionre automatikus szerkesztés
 * - `question`: AskUserQuestion — csak a felhasználó válaszával engedhető tovább
 * - `plan`: ExitPlanMode — elutasítható visszajelzéssel; jóváhagyni a hookból nem lehet
 */
export type DecisionKind = 'tool' | 'edit' | 'question' | 'plan'

export interface PermissionRequestInfo {
  sessionId: string
  cwd: string
  toolName: string
  toolInput: Record<string, unknown>
  /** Csak subagent kérésénél van. A subagent a SZÜLŐ session_id-jával jön; ez különbözteti meg. */
  agentId?: string | undefined
  agentType?: string | undefined
  kind: DecisionKind
  /** Egysoros leírás: a parancs, a fájl, az URL, az első kérdés vagy a terv címe. */
  summary: string
  /** A Claude Code `addRules` javaslatai, kilapítva. Üres, ha nincs (pl. Write/Edit). */
  suggestedRules: PermissionRule[]
  /** Csak `question` fajtánál nem üres. */
  questions: AskQuestion[]
  /** Csak `plan` fajtánál van. */
  plan?: string | undefined
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function kindOf(toolName: string): DecisionKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === 'ExitPlanMode') return 'plan'
  if (EDIT_TOOLS.has(toolName)) return 'edit'
  return 'tool'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function parseOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskOption[] = []
  for (const option of raw) {
    if (!isRecord(option)) continue
    const label = str(option['label'])
    if (label === undefined) continue
    options.push({ label, description: str(option['description']) })
  }
  return options
}

function parseQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: AskQuestion[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const question = str(item['question'])
    if (question === undefined) continue
    questions.push({
      question,
      header: str(item['header']),
      multiSelect: item['multiSelect'] === true,
      options: parseOptions(item['options']),
    })
  }
  return questions
}

function parseSuggestedRules(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return []
  const rules: PermissionRule[] = []
  for (const suggestion of raw) {
    if (!isRecord(suggestion) || suggestion['type'] !== 'addRules') continue
    const list = suggestion['rules']
    if (!Array.isArray(list)) continue
    for (const rule of list) {
      if (!isRecord(rule)) continue
      const toolName = str(rule['toolName'])
      if (toolName === undefined) continue
      rules.push({ toolName, ruleContent: str(rule['ruleContent']) })
    }
  }
  return rules
}

function summarize(
  kind: DecisionKind,
  toolName: string,
  input: Record<string, unknown>,
  questions: readonly AskQuestion[],
): string {
  if (kind === 'question') return questions[0]?.question ?? toolName
  if (kind === 'plan') {
    const title = str(input['plan'])
      ?.split('\n')
      .find((line) => line.trim() !== '')
    return title === undefined ? toolName : oneLine(title.replace(/^#+\s*/, ''))
  }
  const detail = str(input['command']) ?? str(input['file_path']) ?? str(input['url'])
  return detail === undefined ? toolName : oneLine(detail)
}

/** A PermissionRequest hook törzse, értelmezve; `undefined`, ha nem használható. Soha nem dob. */
export function parsePermissionRequest(body: unknown): PermissionRequestInfo | undefined {
  if (!isRecord(body)) return undefined
  const sessionId = str(body['session_id'])
  const toolName = str(body['tool_name'])
  if (sessionId === undefined || toolName === undefined) return undefined

  const rawInput = body['tool_input']
  const toolInput: Record<string, unknown> = isRecord(rawInput) ? rawInput : {}
  const kind = kindOf(toolName)
  const questions = kind === 'question' ? parseQuestions(toolInput['questions']) : []

  return {
    sessionId,
    cwd: str(body['cwd']) ?? '',
    toolName,
    toolInput,
    agentId: str(body['agent_id']),
    agentType: str(body['agent_type']),
    kind,
    summary: summarize(kind, toolName, toolInput, questions),
    suggestedRules: parseSuggestedRules(body['permission_suggestions']),
    questions,
    plan: kind === 'plan' ? str(toolInput['plan']) : undefined,
  }
}
