import type { SessionActivity, SessionStatus, SubagentView } from '@claudeswitcher/core'
import { flatText, isCommandTool, truncate } from '@claudeswitcher/core/browser'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}`
  return `${seconds}mp`
}

/**
 * A running tool in the row: `Bash: pnpm test`, `Grep „createPanel"`, or without a detail `Read fut`.
 * The same for the main session and a subagent, so the two read alike.
 */
export function toolLabel(tool: string, detail?: string): string {
  if (detail === undefined || detail === '') return `${tool} fut`
  // The detail of a tool that runs a command is the command itself, which reads better after a colon.
  return isCommandTool(tool) ? `${tool}: ${detail}` : `${tool} „${detail}"`
}

/** A subagent's work: `<description or type> · <running tool>`, without a tool only the name. */
function subagentWork(subagent: SubagentView): string {
  const name = subagent.description ?? subagent.agentType ?? 'subagent'
  return subagent.runningTool === undefined ? name : `${name} · ${toolLabel(subagent.runningTool, subagent.toolDetail)}`
}

/**
 * The row's tooltip: every active subagent, one per line. `undefined` if there is none: then the
 * row has no tooltip at all.
 */
export function subagentTooltip(subagents: readonly SubagentView[] | undefined): string | undefined {
  if (subagents === undefined || subagents.length === 0) return undefined
  return subagents.map((subagent) => `↳ ${subagentWork(subagent)}`).join('\n')
}

/** The longest a row text may be; core `TOOL_DETAIL_MAX` is sized against it. */
const ROW_TEXT_MAX = 80

function clip(raw: string): string {
  return truncate(flatText(raw) ?? '', ROW_TEXT_MAX)
}

/**
 * A pending request in the row: `Bash: <command>`, cut to one line. So a command of several hundred
 * kilobytes does not go whole into the DOM on every per-second re-render; the full text is the panel's.
 */
export function pendingRowText(pending: { toolName: string; summary: string }): string {
  return clip(`${pending.toolName}: ${pending.summary}`)
}

/** The Agent tool's default type: it is almost always this one, so on its own it says nothing. */
const DEFAULT_AGENT_TYPE = 'general-purpose'

/**
 * The requesting subagent in the panel header: the description of its task (from the session's
 * `subagents` list, by `agentId`), and its type if it is not the default. Without a description,
 * the type. `undefined` if the request belongs to the main session.
 */
export function subagentLabel(
  decision: { agentId?: string | undefined; agentType?: string | undefined },
  subagents: readonly SubagentView[] | undefined,
): string | undefined {
  if (decision.agentId === undefined && decision.agentType === undefined) return undefined
  const match = subagents?.find((subagent) => subagent.agentId === decision.agentId)
  const type = decision.agentType ?? match?.agentType
  const description = match?.description
  if (description === undefined) return type === undefined ? 'subagent' : `subagent · ${type}`
  const label = type === undefined || type === DEFAULT_AGENT_TYPE ? `subagent: ${description}` : `subagent · ${type}: ${description}`
  return clip(label)
}

/**
 * The row's summary. Order: a waiting session's notification; the active subagent's work (the
 * latest one, and `+N` if more run), because the main session then only runs the `Agent` tool, or
 * nothing after the Stop; the main session's running tool; finally the last assistant text.
 * A pending decision is stronger still: App shows it instead of this.
 */
export function summarize(view: {
  status: SessionStatus
  // It can be missing at runtime (see below), so the type says so too.
  activity?: SessionActivity | undefined
  notificationText?: string | undefined
  subagents?: readonly SubagentView[] | undefined
}): string {
  // By its type `activity` is required, but at runtime the daemon's message can be anything. A
  // missing field would throw a render error here that takes down the WHOLE overlay, so this
  // guards here too, not only in the ErrorBoundary.
  const waitingText = view.status === 'waiting' ? view.notificationText : undefined
  const [latest, ...others] = view.subagents ?? []
  if (waitingText === undefined && latest !== undefined) {
    // The `+N` comes first: CSS may cut off the end of the row, and the number must be seen.
    const more = others.length > 0 ? `+${String(others.length)} · ` : ''
    return clip(`↳ ${more}${subagentWork(latest)}`)
  }

  const raw =
    waitingText !== undefined ? waitingText
    : view.status === 'working' && view.activity?.runningTool !== undefined
      ? toolLabel(view.activity.runningTool, view.activity.toolDetail)
    : view.activity?.lastAssistantText ?? '—'

  return clip(raw)
}
