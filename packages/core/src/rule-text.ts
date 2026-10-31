import type { PermissionRule } from './decision.js'

/** Egy szabály a beállításfájlok és a natív prompt írásmódjával: `Bash(ls *)`, vagy a puszta tool név. */
export function formatRule(rule: PermissionRule): string {
  return rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`
}

export type ParsedRules = { ok: true; rules: PermissionRule[] } | { ok: false; line: number; text: string }

/** Tool név, opcionálisan zárójeles tartalommal. A tartalomban lehet zárójel; üres `()` nem. */
const RULE = /^([A-Za-z0-9_-]+)(?:\(([\s\S]+)\))?$/

/**
 * Soronként egy szabály a szerkeszthető előnézetből. Az első hibás sort visszaadja, a számával
 * együtt: egy elgépelt szabály csendes „javítása" más engedélyt adna, mint amit a felhasználó lát.
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
