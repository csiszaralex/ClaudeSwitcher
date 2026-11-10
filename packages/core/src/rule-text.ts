import type { PermissionRule } from './decision.js'

/** A rule as the settings files and the native prompt write it: `Bash(ls *)`, or the bare tool name. */
export function formatRule(rule: PermissionRule): string {
  return rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`
}

export type ParsedRules = { ok: true; rules: PermissionRule[] } | { ok: false; line: number; text: string }

/** A tool name with optional content in parentheses. The content may hold parentheses; an empty `()` is invalid. */
const RULE = /^([A-Za-z0-9_-]+)(?:\(([\s\S]+)\))?$/

/**
 * One rule per line from the editable preview. Returns the first invalid line with its number:
 * silently "fixing" a mistyped rule would grant a different permission than the one the user sees.
 */
export function parseRules(text: string): ParsedRules {
  const rules: PermissionRule[] = []
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '') continue
    const match = RULE.exec(line)
    const toolName = match?.[1]
    if (match === null || toolName === undefined) return { ok: false, line: index + 1, text: line }
    const content = match[2]
    rules.push(content === undefined ? { toolName } : { toolName, ruleContent: content })
  }
  return { ok: true, rules }
}
