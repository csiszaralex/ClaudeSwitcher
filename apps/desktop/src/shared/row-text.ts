import { flatText, truncate } from '@claudeswitcher/core/browser'

/** The longest a row text may be; core `TOOL_DETAIL_MAX` is sized against it. */
const ROW_TEXT_MAX = 80

/** One line, cut to `ROW_TEXT_MAX`: how every row text, and the notification body, is shortened. */
export function clip(raw: string): string {
  return truncate(flatText(raw) ?? '', ROW_TEXT_MAX)
}

/**
 * A pending request in the row: `Bash: <command>`, cut to one line. So a command of several hundred
 * kilobytes does not go whole into the DOM on every per-second re-render; the full text is the panel's.
 * The permission notification's body uses it too.
 */
export function pendingRowText(pending: { toolName: string; summary: string }): string {
  return clip(`${pending.toolName}: ${pending.summary}`)
}
