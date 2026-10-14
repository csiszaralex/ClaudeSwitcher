import { describe, expect, it } from 'vitest'
import { formatRule, parseRules } from './rule-text.js'

describe('formatRule', () => {
  it('writes a rule the way the settings files and the native prompt show it', () => {
    expect(formatRule({ toolName: 'Bash', ruleContent: 'echo spike-a *' })).toBe('Bash(echo spike-a *)')
    expect(formatRule({ toolName: 'WebFetch', ruleContent: 'domain:example.com' })).toBe('WebFetch(domain:example.com)')
  })

  it('writes an MCP rule as the bare tool name', () => {
    expect(formatRule({ toolName: 'mcp__claude-vscode__getDiagnostics' })).toBe('mcp__claude-vscode__getDiagnostics')
  })
})

describe('parseRules', () => {
  it('reads one rule per non-empty line, round-tripping formatRule', () => {
    expect(parseRules('Bash(echo spike-a *)\n\n  mcp__claude-vscode__getDiagnostics  \n')).toEqual({
      ok: true,
      rules: [{ toolName: 'Bash', ruleContent: 'echo spike-a *' }, { toolName: 'mcp__claude-vscode__getDiagnostics' }],
    })
  })

  it('keeps parentheses that belong to the content', () => {
    expect(parseRules('Bash(echo (x) *)')).toEqual({ ok: true, rules: [{ toolName: 'Bash', ruleContent: 'echo (x) *' }] })
  })

  it('reports the first bad line with its 1-based number instead of guessing', () => {
    // Egy elgépelt szabály csendes javítása veszélyes lenne: más engedélyt adna, mint amit a
    // felhasználó lát. Inkább megmondjuk, melyik sor rossz.
    expect(parseRules('Bash(ls *)\nBash()\nWebFetch(domain:x)')).toEqual({ ok: false, line: 2, text: 'Bash()' })
    expect(parseRules('Bash(ls *')).toEqual({ ok: false, line: 1, text: 'Bash(ls *' })
    expect(parseRules('két szó')).toEqual({ ok: false, line: 1, text: 'két szó' })
  })

  it('returns an empty list for empty text — the caller decides whether that is allowed', () => {
    expect(parseRules('  \n ')).toEqual({ ok: true, rules: [] })
  })
})
