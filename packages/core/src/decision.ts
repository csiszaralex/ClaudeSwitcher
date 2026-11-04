/**
 * A PermissionRequest hook bemenetének értelmezése. Tiszta függvények, IO nélkül.
 *
 * A bemenet alakja a VSCode bővítményben MÉRVE (spikes/m2-permission/RESULTS.md), nem a
 * dokumentációból: a tesztek a packages/core/fixtures/hook-payloads.json valódi törzseit
 * használják.
 */

import { flatText, isRecord, nonEmptyString } from './guards.js'
import { isCommandTool, isEditTool } from './tool-names.js'

/** Egy jogosultsági szabály, ahogy a Claude Code `permission_suggestions`-ben adja. */
export interface PermissionRule {
  toolName: string
  /** Pl. `echo spike-a *`. MCP-toolnál nincs: ott a szabály maga a tool neve. */
  ruleContent?: string | undefined
}

/** Hova írja a Claude Code a szabályt: a projekt helyi beállításaiba, vagy a gépszintűbe. */
export type RuleDestination = 'localSettings' | 'userSettings'

interface AskOption {
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
 * - `tool` (parancs, WebFetch, MCP): engedélyez / tilt / projekt- vagy gépszintű szabály
 * - `edit` (fájlírás): engedélyez / tilt / erre a sessionre automatikus szerkesztés
 * - `question` (AskUserQuestion): csak a felhasználó válaszával engedhető tovább
 * - `plan` (ExitPlanMode): elutasítható visszajelzéssel; jóváhagyni a hookból nem lehet
 */
const DECISION_KINDS = ['tool', 'edit', 'question', 'plan'] as const

export type DecisionKind = (typeof DECISION_KINDS)[number]

const DECISION_KIND_SET: ReadonlySet<unknown> = new Set(DECISION_KINDS)

/** Igaz, ha az érték a `DECISION_KINDS` egyike; a renderer ezzel ellenőrzi a daemontól jött fajtát. */
export function isDecisionKind(value: unknown): value is DecisionKind {
  return DECISION_KIND_SET.has(value)
}

export interface PermissionRequestInfo {
  sessionId: string
  cwd: string
  toolName: string
  toolInput: Record<string, unknown>
  /** Csak subagent kérésénél van. A subagent a SZÜLŐ session_id-jával jön; ez különbözteti meg. */
  agentId?: string | undefined
  agentType?: string | undefined
  kind: DecisionKind
  /**
   * Rövid leírás: a parancs, a fájl, az URL, az első kérdés, a terv címe vagy a Workflow neve.
   * A parancs a sortöréseit MEGTARTJA (csak a két vége vágott, `\n` sorvéggel); a többi egysoros.
   */
  summary: string
  /**
   * Az eszköz saját, emberi leírása, egy sorban: a Bash `tool_input.description`-je (a VSCode a
   * parancs alatt mutatja), Workflow-nál a szkript `meta.description`-je. Nincs, ha az eszköz nem ad.
   */
  description?: string | undefined
  /** A Claude Code `addRules` javaslatai, kilapítva. Üres, ha nincs (pl. Write/Edit). */
  suggestedRules: PermissionRule[]
  /** Csak `question` fajtánál nem üres. */
  questions: AskQuestion[]
  /** Csak `plan` fajtánál van. */
  plan?: string | undefined
  /**
   * Hamis, ha a kérés lényegét nem tudtuk kiolvasni (megváltozott `tool_input` alak): a parancs,
   * a fájl útvonala vagy az URL hiányzik. A panel ilyenkor csak az eszköz nevét mutatná, ezért a
   * `buildHookResponse` minden engedélyezést elutasít rá; a tiltás és a VSCode marad.
   */
  readable: boolean
}

/**
 * Eszközönként az a mező, ami nélkül a kérés vakon menne át: a parancs, a fájl útvonala, az URL.
 * A NotebookEdit a `notebook_path`-ban adja a fájlt. Erre nincs mért payload a fixture-ökben; a
 * mezőnév a Claude Code NotebookEdit bemenete, és a `toolDetail` (tool-detail.ts) is ezt olvassa.
 * Ami itt nincs, az olvashatónak számít: egy MCP-toolnak vagy egy ismeretlen eszköznek nincs
 * kötelező mezője, a nyers bemenete a részletekben látszik.
 *
 * The tool sets come from `tool-names.ts`, so a new command or edit tool gets the check by itself.
 */
function requiredField(toolName: string): string | undefined {
  if (isCommandTool(toolName)) return 'command'
  if (toolName === 'NotebookEdit') return 'notebook_path'
  if (isEditTool(toolName)) return 'file_path'
  if (toolName === 'WebFetch') return 'url'
  return undefined
}

/** A kötelező mező egy nem üres szöveg; csupa szóköz nem az, abból sem látszana semmi. */
function isReadable(toolName: string, input: Record<string, unknown>): boolean {
  const field = requiredField(toolName)
  if (field === undefined) return true
  const value = input[field]
  return typeof value === 'string' && value.trim() !== ''
}

function kindOf(toolName: string): DecisionKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === 'ExitPlanMode') return 'plan'
  if (isEditTool(toolName)) return 'edit'
  return 'tool'
}

function parseOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskOption[] = []
  for (const option of raw) {
    if (!isRecord(option)) continue
    const label = nonEmptyString(option['label'])
    if (label === undefined) continue
    options.push({ label, description: nonEmptyString(option['description']) })
  }
  return options
}

function parseQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: AskQuestion[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const question = nonEmptyString(item['question'])
    if (question === undefined) continue
    questions.push({
      question,
      header: nonEmptyString(item['header']),
      multiSelect: item['multiSelect'] === true,
      options: parseOptions(item['options']),
    })
  }
  return questions
}

/**
 * Csak az engedélyező (`behavior: 'allow'`) `addRules` javaslatok: a mért payloadokban a
 * `behavior` a javaslat szintjén áll. Egy tiltó vagy kérdező javaslat engedélyező szabályként
 * az ellenkezőjét adná annak, amit a Claude Code javasolt.
 *
 * A `ruleContent` nélküli szabály a puszta tool (MCP-nél ez a természetes alak). Egy üres vagy nem
 * szöveges `ruleContent` viszont nem ugyanaz: abból puszta tool, vagyis a tool MINDEN hívására
 * szóló szabály lenne, ezért az ilyen szabály kiesik.
 */
function parseSuggestedRules(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return []
  const rules: PermissionRule[] = []
  for (const suggestion of raw) {
    if (!isRecord(suggestion) || suggestion['type'] !== 'addRules' || suggestion['behavior'] !== 'allow') continue
    const list = suggestion['rules']
    if (!Array.isArray(list)) continue
    for (const rule of list) {
      if (!isRecord(rule)) continue
      const toolName = nonEmptyString(rule['toolName'])
      if (toolName === undefined) continue
      if (!('ruleContent' in rule)) {
        rules.push({ toolName, ruleContent: undefined })
        continue
      }
      const ruleContent = nonEmptyString(rule['ruleContent'])
      if (ruleContent !== undefined) rules.push({ toolName, ruleContent })
    }
  }
  return rules
}

/** Egy idézett szöveg (', " vagy `), benne escape-elt karakterekkel. */
const QUOTED = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`

function metaField(meta: string, field: string): string | undefined {
  const match = new RegExp(String.raw`\b${field}\s*:\s*${QUOTED}`).exec(meta)
  const raw = match?.[2]
  if (raw === undefined) return undefined
  return flatText(raw.replace(/\\(.)/g, '$1'))
}

/**
 * A Workflow szkriptjének `export const meta = { name, description, … }` blokkja. A tool_input
 * csak `{ script, args }`, a javaslat null (mérve, Task 10 D), a nevet és a leírást csak innen
 * lehet kiolvasni. Tűrő minta, és ha nem illeszkedik, egyszerűen nincs eredmény: egy furcsa
 * szkript miatt a kérés nem eshet ki, legfeljebb „Workflow" marad a felirata.
 *
 * A keresés a blokk első `}`-jéig tart, hogy a szkript későbbi `name:`-je (pl. egy lépés neve)
 * ne legyen a workflow neve. A név és a leírás a mintákban a blokk elején áll.
 */
function workflowMeta(input: Record<string, unknown>): { name?: string | undefined; description?: string | undefined } {
  const script = nonEmptyString(input['script'])
  if (script === undefined) return {}
  const start = /\bmeta\s*=\s*\{/.exec(script)
  if (start === null) return {}
  const rest = script.slice(start.index + start[0].length)
  const end = rest.indexOf('}')
  const meta = end === -1 ? rest : rest.slice(0, end)
  return { name: metaField(meta, 'name'), description: metaField(meta, 'description') }
}

function summarize(
  kind: DecisionKind,
  toolName: string,
  input: Record<string, unknown>,
  questions: readonly AskQuestion[],
): string {
  if (kind === 'question') return questions[0]?.question ?? toolName
  if (kind === 'plan') {
    const title = nonEmptyString(input['plan'])
      ?.split('\n')
      .find((line) => line.trim() !== '')
    // A heading-only line (`##`) gives an empty title, not the tool name.
    return title === undefined ? toolName : (flatText(title.replace(/^#+\s*/, '')) ?? '')
  }
  if (toolName === 'Workflow') return workflowMeta(input).name ?? toolName
  // A parancs sortörései jelentést hordoznak (többsoros szkript, heredoc): laposítva a panel
  // mást mutatna, mint amit a felhasználó jóváhagy. Csak a két végét vágjuk.
  const command = nonEmptyString(input['command'])
  if (command !== undefined) return command.replace(/\r\n?/g, '\n').trim()
  const target = nonEmptyString(input['file_path']) ?? nonEmptyString(input['notebook_path']) ?? nonEmptyString(input['url'])
  // A whitespace-only target gives an empty summary, not the tool name.
  return target === undefined ? toolName : (flatText(target) ?? '')
}

/** Csak `tool` fajtánál: a fájlírásnak, a kérdésnek és a tervnek nincs ilyen leírása. */
function describeTool(kind: DecisionKind, toolName: string, input: Record<string, unknown>): string | undefined {
  if (kind !== 'tool') return undefined
  if (toolName === 'Workflow') return workflowMeta(input).description
  return flatText(input['description'])
}

/** A PermissionRequest hook törzse, értelmezve; `undefined`, ha nem használható. Soha nem dob. */
export function parsePermissionRequest(body: unknown): PermissionRequestInfo | undefined {
  if (!isRecord(body)) return undefined
  const sessionId = nonEmptyString(body['session_id'])
  const toolName = nonEmptyString(body['tool_name'])
  if (sessionId === undefined || toolName === undefined) return undefined

  const rawInput = body['tool_input']
  const toolInput: Record<string, unknown> = isRecord(rawInput) ? rawInput : {}
  const kind = kindOf(toolName)
  const questions = kind === 'question' ? parseQuestions(toolInput['questions']) : []

  return {
    sessionId,
    cwd: nonEmptyString(body['cwd']) ?? '',
    toolName,
    toolInput,
    agentId: nonEmptyString(body['agent_id']),
    agentType: nonEmptyString(body['agent_type']),
    kind,
    summary: summarize(kind, toolName, toolInput, questions),
    description: describeTool(kind, toolName, toolInput),
    suggestedRules: parseSuggestedRules(body['permission_suggestions']),
    questions,
    plan: kind === 'plan' ? nonEmptyString(toolInput['plan']) : undefined,
    readable: isReadable(toolName, toolInput),
  }
}
