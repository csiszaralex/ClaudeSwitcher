/**
 * Parsing of the PermissionRequest hook's input. Pure functions, no IO.
 *
 * The input shape was MEASURED with the VS Code extension (spikes/m2-permission/RESULTS.md), not
 * taken from the documentation: the tests use the real bodies in
 * packages/core/fixtures/hook-payloads.json.
 */

import { flatText, isRecord, nonEmptyString } from './guards.js'
import { isCommandTool, isEditTool } from './tool-names.js'

/** A permission rule as Claude Code gives it in `permission_suggestions`. */
export interface PermissionRule {
  toolName: string
  /** E.g. `echo spike-a *`. Absent for an MCP tool: there the rule is the tool name itself. */
  ruleContent?: string | undefined
}

/** Where Claude Code writes the rule: the project's local settings or the user-level settings. */
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
 * What the overlay offers for a request (the table in the design doc, section 5):
 * - `tool` (command, WebFetch, MCP): allow / deny / a project or user-level rule
 * - `edit` (file write): allow / deny / accept edits automatically for this session
 * - `question` (AskUserQuestion): goes through only with the user's answer
 * - `plan` (ExitPlanMode): can be rejected with feedback; the hook cannot approve it
 */
const DECISION_KINDS = ['tool', 'edit', 'question', 'plan'] as const

export type DecisionKind = (typeof DECISION_KINDS)[number]

const DECISION_KIND_SET: ReadonlySet<unknown> = new Set(DECISION_KINDS)

/** True for one of `DECISION_KINDS`; the renderer checks the kind sent by the daemon with it. */
export function isDecisionKind(value: unknown): value is DecisionKind {
  return DECISION_KIND_SET.has(value)
}

export interface PermissionRequestInfo {
  sessionId: string
  cwd: string
  toolName: string
  toolInput: Record<string, unknown>
  /** Present only on a subagent's request. A subagent comes with its PARENT's session_id; this tells them apart. */
  agentId?: string | undefined
  agentType?: string | undefined
  kind: DecisionKind
  /**
   * A short summary: the command, the file, the URL, the first question, the plan's title or the
   * Workflow's name. The command KEEPS its line breaks (only its ends are trimmed, with `\n` line
   * ends); the others are one line.
   */
  summary: string
  /**
   * The tool's own human description, in one line: Bash's `tool_input.description` (VS Code shows
   * it under the command), for Workflow the script's `meta.description`. Absent when the tool gives none.
   */
  description?: string | undefined
  /** Claude Code's `addRules` suggestions, flattened. Empty when there are none (e.g. Write/Edit). */
  suggestedRules: PermissionRule[]
  /** Non-empty only for the `question` kind. */
  questions: AskQuestion[]
  /** Present only for the `plan` kind. */
  plan?: string | undefined
  /**
   * False when the essence of the request could not be read (a changed `tool_input` shape): the
   * command, the file path or the URL is missing. The panel would show only the tool name, so
   * `buildHookResponse` refuses every allow for it; deny and VS Code remain.
   */
  readable: boolean
}

/**
 * Per tool, the field without which the request would go through blind: the command, the file
 * path, the URL. NotebookEdit gives the file in `notebook_path`. The fixtures hold no measured
 * payload for it; the field name is that of Claude Code's NotebookEdit input, and `toolDetail`
 * (tool-detail.ts) reads it too. A tool not listed here counts as readable: an MCP tool or an
 * unknown tool has no required field, and its raw input shows in the details.
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

/** The required field is a non-empty string; whitespace only does not count, it would show nothing either. */
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
 * Only the allowing (`behavior: 'allow'`) `addRules` suggestions: in the measured payloads
 * `behavior` sits at the suggestion level. A deny or ask suggestion turned into an allow rule would
 * grant the opposite of what Claude Code suggested.
 *
 * A rule without `ruleContent` is the bare tool (the natural form for MCP). An empty or non-string
 * `ruleContent` is not the same: it would become a bare tool, a rule for EVERY call of the tool,
 * so such a rule is dropped.
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

/** A quoted string (', " or `) with escaped characters inside. */
const QUOTED = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`

function metaField(meta: string, field: string): string | undefined {
  const match = new RegExp(String.raw`\b${field}\s*:\s*${QUOTED}`).exec(meta)
  const raw = match?.[2]
  if (raw === undefined) return undefined
  return flatText(raw.replace(/\\(.)/g, '$1'))
}

/**
 * The `export const meta = { name, description, … }` block of a Workflow script. The tool_input is
 * only `{ script, args }` and the suggestion is null (measured live), so the name and the
 * description can only be read from here. A tolerant pattern, and when it does not match there is
 * simply no result: an odd script must not drop the request, at worst its label stays "Workflow".
 *
 * The search stops at the block's first `}`, so that a later `name:` in the script (e.g. a step's
 * name) does not become the workflow's name. In the samples the name and the description come
 * first in the block.
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
  // A command's line breaks carry meaning (a multi-line script, a heredoc): flattened, the panel
  // would show something other than what the user approves. Only its ends are trimmed.
  const command = nonEmptyString(input['command'])
  if (command !== undefined) return command.replace(/\r\n?/g, '\n').trim()
  const target = nonEmptyString(input['file_path']) ?? nonEmptyString(input['notebook_path']) ?? nonEmptyString(input['url'])
  // A whitespace-only target gives an empty summary, not the tool name.
  return target === undefined ? toolName : (flatText(target) ?? '')
}

/** Only for the `tool` kind: a file write, a question and a plan have no such description. */
function describeTool(kind: DecisionKind, toolName: string, input: Record<string, unknown>): string | undefined {
  if (kind !== 'tool') return undefined
  if (toolName === 'Workflow') return workflowMeta(input).description
  return flatText(input['description'])
}

/** The parsed body of the PermissionRequest hook; `undefined` when it is unusable. Never throws. */
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
