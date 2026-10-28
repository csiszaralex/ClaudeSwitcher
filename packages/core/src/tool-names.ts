/**
 * A Claude Code eszköznevei, amelyekhez az app külön viselkedést köt. IO-mentes, a `/browser`
 * belépési pont is exportálja.
 */

/** Fájlt író eszközök: `edit` fajtájú döntés, a panel előnézetet mutat róluk. */
export const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

export type EditTool = (typeof EDIT_TOOLS)[number]

const EDIT_TOOL_SET: ReadonlySet<string> = new Set(EDIT_TOOLS)

export function isEditTool(toolName: string): toolName is EditTool {
  return EDIT_TOOL_SET.has(toolName)
}

/** Parancsot futtató eszközök: a részletük maga a parancs (és a leírása). */
export const COMMAND_TOOLS = ['Bash', 'PowerShell'] as const

export type CommandTool = (typeof COMMAND_TOOLS)[number]

const COMMAND_TOOL_SET: ReadonlySet<string> = new Set(COMMAND_TOOLS)

export function isCommandTool(toolName: string): toolName is CommandTool {
  return COMMAND_TOOL_SET.has(toolName)
}
