import type { DecisionKind } from '@claudeswitcher/core'
import { COMMAND_TOOLS, isRecord } from '@claudeswitcher/core/browser'

/**
 * At most this many characters show in the expandable details. A Workflow script of several
 * hundred kilobytes in the `<pre>` would freeze the overlay for seconds; the decision does not need
 * all of it anyway, and the full text is there in VS Code.
 */
export const DETAILS_LIMIT = 20_000

/** Above this a single-line string also gets a block of its own, not one endless JSON line. */
const LONG_STRING = 120

/**
 * Tools that run a command: for them the command (the summary) and the description are already at
 * the top of the panel, and the details do not repeat them. Every other field (timeout, background
 * run, turning off the sandbox) goes into the details: with a hidden field, a run without the
 * sandbox would look the same as one with it.
 */
const SHOWN_ABOVE: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  COMMAND_TOOLS.map((tool) => [tool, new Set(['command', 'description'])]),
)

interface DetailBlock {
  /** The field name if the block is a single string field; the JSON block has none. */
  label?: string | undefined
  text: string
}

export interface ToolDetails {
  blocks: DetailBlock[]
  /** True if something was left out because of `DETAILS_LIMIT`. The panel says so. */
  truncated: boolean
}

interface DetailSource {
  kind: DecisionKind
  toolName: string
  /** sanitizeState does not check `toolInput`, hence `unknown`. */
  toolInput: unknown
}

/** The fields that go into the details: the input without the fields already shown at the top of the panel. */
function detailFields(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const above = SHOWN_ABOVE[toolName]
  if (above === undefined) return input
  return Object.fromEntries(Object.entries(input).filter(([key]) => !above.has(key)))
}

/**
 * Whether the request gets expandable details. Only for the `tool` kind: the file write, the
 * question and the plan have views of their own. For a command only if it has a field besides the
 * command and the description.
 */
export function showsDetails(decision: DetailSource): boolean {
  return (
    decision.kind === 'tool' &&
    isRecord(decision.toolInput) &&
    Object.keys(detailFields(decision.toolName, decision.toolInput)).length > 0
  )
}

/** The details of a `tool` kind request as `showsDetails` decides; `undefined` if there is nothing to show. */
export function toolDetails(decision: DetailSource): ToolDetails | undefined {
  if (!showsDetails(decision) || !isRecord(decision.toolInput)) return undefined
  return formatToolInput(detailFields(decision.toolName, decision.toolInput))
}

/**
 * The Bash field `dangerouslyDisableSandbox: true`: the command would run outside the sandbox. The
 * panel shows this in a red line, without expanding the details. Only an explicit `true` counts.
 */
export function sandboxDisabled(toolInput: unknown): boolean {
  return isRecord(toolInput) && toolInput['dangerouslyDisableSandbox'] === true
}

/**
 * The `toolInput` as readable text, with a size limit. Never throws.
 *
 * Multi-line or long string fields (the Workflow `script`, the prompt of an MCP call) get blocks of
 * their own with their own line breaks: in JSON they would be a single line full of `\n`s that
 * nobody can read. The other fields come first, as pretty JSON.
 */
export function formatToolInput(input: unknown, limit: number = DETAILS_LIMIT): ToolDetails {
  if (!isRecord(input)) return { blocks: [], truncated: false }

  const rest: Record<string, unknown> = {}
  const texts: DetailBlock[] = []
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && (value.includes('\n') || value.length > LONG_STRING)) {
      texts.push({ label: key, text: value })
    } else {
      rest[key] = value
    }
  }

  const all: DetailBlock[] = []
  if (Object.keys(rest).length > 0) {
    try {
      all.push({ text: JSON.stringify(rest, null, 2) })
    } catch {
      // This cannot happen with JSON that came over IPC; if it does, the text blocks are still fine.
    }
  }
  all.push(...texts)

  // The limit applies to ALL blocks together: many medium fields add up too.
  const blocks: DetailBlock[] = []
  let budget = limit
  for (const block of all) {
    if (budget <= 0) return { blocks, truncated: true }
    if (block.text.length > budget) {
      blocks.push({ ...block, text: block.text.slice(0, budget) })
      return { blocks, truncated: true }
    }
    blocks.push(block)
    budget -= block.text.length
  }
  return { blocks, truncated: false }
}
