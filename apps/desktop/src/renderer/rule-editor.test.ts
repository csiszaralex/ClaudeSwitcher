import { describe, expect, it } from 'vitest'
import { broadRules, editorRows, RULE_EDITOR_MAX_ROWS, RULE_EDITOR_MIN_ROWS, ruleEditorSeed } from './rule-editor.js'

describe('editorRows', () => {
  it('grows with the line count between the minimum and the cap', () => {
    expect(editorRows('Bash(ls *)')).toBe(RULE_EDITOR_MIN_ROWS)
    expect(editorRows('a\nb\nc\nd\ne')).toBe(5)
    expect(editorRows(Array.from({ length: 50 }, () => 'Bash(x)').join('\n'))).toBe(RULE_EDITOR_MAX_ROWS)
  })
})

describe('ruleEditorSeed', () => {
  it('writes one suggested rule per line', () => {
    expect(ruleEditorSeed([{ toolName: 'Bash', ruleContent: 'ls *' }, { toolName: 'mcp__x__y' }])).toEqual({
      text: 'Bash(ls *)\nmcp__x__y',
      multiline: 0,
    })
  })

  it('leaves out a suggestion with a line break, which the editor would split into several rules', () => {
    expect(
      ruleEditorSeed([
        { toolName: 'Bash', ruleContent: 'cat <<END\nrm -rf x\nEND' },
        { toolName: 'Bash', ruleContent: 'a\r\nb' },
        { toolName: 'Bash', ruleContent: 'ls *' },
      ]),
    ).toEqual({ text: 'Bash(ls *)', multiline: 2 })
  })
})

describe('broadRules', () => {
  it('flags a bare tool rule and a wildcard-only content, both needing confirmation', () => {
    expect(
      broadRules([
        { toolName: 'Bash' },
        { toolName: 'Write' },
        { toolName: 'Bash', ruleContent: '*' },
        { toolName: 'Bash', ruleContent: ':*' },
        { toolName: 'Bash', ruleContent: ' * ' },
      ]),
    ).toEqual([
      { rule: 'Bash', confirm: true },
      { rule: 'Write', confirm: true },
      { rule: 'Bash(*)', confirm: true },
      { rule: 'Bash(:*)', confirm: true },
      { rule: 'Bash( * )', confirm: true },
    ])
  })

  it('notes a bare MCP tool rule without asking for confirmation, since that is its normal form', () => {
    expect(broadRules([{ toolName: 'mcp__github__create_issue' }])).toEqual([
      { rule: 'mcp__github__create_issue', confirm: false },
    ])
  })

  it('leaves a rule with real content alone', () => {
    expect(
      broadRules([
        { toolName: 'Bash', ruleContent: 'ls *' },
        { toolName: 'Bash', ruleContent: 'git:*' },
        { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
      ]),
    ).toEqual([])
  })
})
