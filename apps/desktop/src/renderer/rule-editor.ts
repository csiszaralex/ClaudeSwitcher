import type { PermissionRule } from '@claudeswitcher/core'
import { formatRule } from '@claudeswitcher/core/browser'

/** The rule editor has at least this many rows. */
export const RULE_EDITOR_MIN_ROWS = 3
/** It grows to at most this many rows; above that the field scrolls, so the buttons stay on the panel. */
export const RULE_EDITOR_MAX_ROWS = 12

/** The editor height fitted to the text's line count: a rule slipping below must not hide either. */
export function editorRows(text: string): number {
  const lines = text.split('\n').length
  return Math.min(RULE_EDITOR_MAX_ROWS, Math.max(RULE_EDITOR_MIN_ROWS, lines))
}

export interface RuleSeed {
  /** The editor's initial text, one rule per line. */
  text: string
  /** How many suggestions were left out because they contain a line break. */
  multiline: number
}

const LINE_BREAK = /[\r\n]/

/**
 * The editor's initial text from Claude Code's suggestions. The editor reads one rule per line
 * (`parseRules`), so a suggestion containing a line break (e.g. the rule of a heredoc command)
 * would fall apart into several rules that allow something else. Such a suggestion is left out,
 * and the editor says so.
 */
export function ruleEditorSeed(rules: readonly PermissionRule[]): RuleSeed {
  const kept = rules.filter(
    (rule) => !LINE_BREAK.test(rule.toolName) && (rule.ruleContent === undefined || !LINE_BREAK.test(rule.ruleContent)),
  )
  return { text: kept.map(formatRule).join('\n'), multiline: rules.length - kept.length }
}

/**
 * The rule buttons' tooltip when Claude Code suggests a rule (`permission_suggestions`): the
 * suggestion exactly as the editor's initial text will be (`ruleEditorSeed`), and how many
 * multi-line suggestions are left out of it. `undefined` if there is no suggestion: then the
 * buttons do not change.
 */
export function suggestionTooltip(rules: readonly PermissionRule[]): string | undefined {
  if (rules.length === 0) return undefined
  const seed = ruleEditorSeed(rules)
  const lines = ['A Claude Code szabályt javasol:']
  if (seed.text !== '') lines.push(seed.text)
  if (seed.multiline > 0) lines.push(`${suggestionCount(seed.multiline)} többsoros, a szerkesztő kihagyja.`)
  return lines.join('\n')
}

/** "One suggested rule" or "N suggested rules": the wording shared by the tooltip and the editor. */
export function suggestionCount(count: number): string {
  return count === 1 ? 'Egy javasolt szabály' : `${String(count)} javasolt szabály`
}

export interface BroadRule {
  /** The rule in the editor's notation. */
  rule: string
  /** Whether it needs a separate confirmation. Not for an MCP tool: there the bare name is the usual rule form. */
  confirm: boolean
}

/** Only asterisks, colons and spaces: matches every call of the tool. */
const WILDCARD_ONLY = /^[\s*:]*$/

/**
 * The rules that allow EVERY call of the tool: the bare tool name (`Bash`, `Write`) and content made
 * of wildcards only (`Bash(*)`, `Bash(:*)`). The editor gives a red warning for these and, except
 * for MCP tools, asks for a confirmation.
 */
export function broadRules(rules: readonly PermissionRule[]): BroadRule[] {
  return rules
    .filter((rule) => rule.ruleContent === undefined || WILDCARD_ONLY.test(rule.ruleContent))
    .map((rule) => ({ rule: formatRule(rule), confirm: !rule.toolName.startsWith('mcp__') }))
}
