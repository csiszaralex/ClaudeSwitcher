import type { PermissionRule } from '@claudeswitcher/core'
import { formatRule } from '@claudeswitcher/core/browser'

/** A szabályszerkesztő legalább ennyi soros. */
export const RULE_EDITOR_MIN_ROWS = 3
/** Legfeljebb ennyi sorig nő; afölött a mező görget, hogy a gombok a panelen maradjanak. */
export const RULE_EDITOR_MAX_ROWS = 12

/** A szerkesztő magassága a szöveg sorszámához igazítva: az alá csúszó szabály se bújhasson el. */
export function editorRows(text: string): number {
  const lines = text.split('\n').length
  return Math.min(RULE_EDITOR_MAX_ROWS, Math.max(RULE_EDITOR_MIN_ROWS, lines))
}

export interface RuleSeed {
  /** A szerkesztő kezdőszövege, soronként egy szabály. */
  text: string
  /** Hány javaslat maradt ki, mert sortörés van benne. */
  multiline: number
}

const LINE_BREAK = /[\r\n]/

/**
 * A szerkesztő kezdőszövege a Claude Code javaslataiból. A szerkesztő soronként egy szabályt
 * olvas (`parseRules`), így egy sortörést tartalmazó javaslat (pl. egy heredoc-os parancs
 * szabálya) több, mást engedélyező szabállyá esne szét. Az ilyen javaslat kimarad, és a
 * szerkesztő ezt ki is írja.
 */
export function ruleEditorSeed(rules: readonly PermissionRule[]): RuleSeed {
  const kept = rules.filter(
    (rule) => !LINE_BREAK.test(rule.toolName) && (rule.ruleContent === undefined || !LINE_BREAK.test(rule.ruleContent)),
  )
  return { text: kept.map(formatRule).join('\n'), multiline: rules.length - kept.length }
}

/**
 * A szabálygombok tooltipje, ha a Claude Code szabályt javasol (`permission_suggestions`): a
 * javaslat pontosan úgy, ahogy a szerkesztő kezdőszövege lesz (`ruleEditorSeed`), és hogy hány
 * többsoros javaslat marad ki belőle. `undefined`, ha nincs javaslat: ilyenkor a gombok nem változnak.
 */
export function suggestionTooltip(rules: readonly PermissionRule[]): string | undefined {
  if (rules.length === 0) return undefined
  const seed = ruleEditorSeed(rules)
  const lines = ['A Claude Code szabályt javasol:']
  if (seed.text !== '') lines.push(seed.text)
  if (seed.multiline > 0) lines.push(`${suggestionCount(seed.multiline)} többsoros, a szerkesztő kihagyja.`)
  return lines.join('\n')
}

/** „Egy javasolt szabály" vagy „N javasolt szabály": a tooltip és a szerkesztő közös szava. */
export function suggestionCount(count: number): string {
  return count === 1 ? 'Egy javasolt szabály' : `${String(count)} javasolt szabály`
}

export interface BroadRule {
  /** A szabály a szerkesztő írásmódjával. */
  rule: string
  /** Kell-e hozzá külön megerősítés. MCP-toolnál nem: ott a puszta név a szabály szokásos alakja. */
  confirm: boolean
}

/** Csak csillag, kettőspont és szóköz: a tool minden hívására illeszkedik. */
const WILDCARD_ONLY = /^[\s*:]*$/

/**
 * A tool MINDEN hívását engedélyező szabályok: a puszta tool név (`Bash`, `Write`) és a csak
 * helyettesítő karakterből álló tartalom (`Bash(*)`, `Bash(:*)`). A szerkesztő ezekre piros
 * figyelmeztetést ad, és az MCP-toolok kivételével megerősítést kér.
 */
export function broadRules(rules: readonly PermissionRule[]): BroadRule[] {
  return rules
    .filter((rule) => rule.ruleContent === undefined || WILDCARD_ONLY.test(rule.ruleContent))
    .map((rule) => ({ rule: formatRule(rule), confirm: !rule.toolName.startsWith('mcp__') }))
}
