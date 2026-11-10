/**
 * The Claude Code tool names the app treats specially. IO-free, also exported by the `/browser`
 * entry point.
 */

/** Tools that write files: their decision kind is `edit`, and the panel shows a preview. */
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

export type EditTool = (typeof EDIT_TOOLS)[number]

const EDIT_TOOL_SET: ReadonlySet<string> = new Set(EDIT_TOOLS)

export function isEditTool(toolName: string): toolName is EditTool {
  return EDIT_TOOL_SET.has(toolName)
}

/** Tools that run a command: their detail is the command itself (and its description). */
export const COMMAND_TOOLS = ['Bash', 'PowerShell'] as const

export type CommandTool = (typeof COMMAND_TOOLS)[number]

const COMMAND_TOOL_SET: ReadonlySet<string> = new Set(COMMAND_TOOLS)

export function isCommandTool(toolName: string): toolName is CommandTool {
  return COMMAND_TOOL_SET.has(toolName)
}
