import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePermissionRequest, type PermissionRequestInfo } from './decision.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

/** A spike-ban rögzített valódi törzs. Hiányzó névnél dob, hogy egy elgépelés ne csússzon át. */
function fixture(name: string): unknown {
  const value = fixtures[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function parsed(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(fixture(name))
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return info
}

describe('parsePermissionRequest — a spike valódi payloadjai', () => {
  it.each([
    ['permissionRequest_bash', 'Bash', 'tool', 'echo spike-a > a.txt'],
    ['permissionRequest_write', 'Write', 'edit', 'P:\\08_Apps\\cs-spike\\b.txt'],
    ['permissionRequest_edit', 'Edit', 'edit', 'P:\\08_Apps\\cs-spike\\b.txt'],
    ['permissionRequest_webFetch', 'WebFetch', 'tool', 'https://example.com'],
    ['permissionRequest_mcp', 'mcp__claude-vscode__getDiagnostics', 'tool', 'mcp__claude-vscode__getDiagnostics'],
    ['permissionRequest_askSingle', 'AskUserQuestion', 'question', 'Mi legyen a k1.txt tartalma?'],
    ['permissionRequest_plan', 'ExitPlanMode', 'plan', 'Terv: c.txt létrehozása'],
    ['permissionRequest_workflow', 'Workflow', 'tool', 'acceptance-probe'],
  ] as const)('%s → %s, %s', (name, toolName, kind, summary) => {
    const info = parsed(name)
    expect(info.toolName).toBe(toolName)
    expect(info.kind).toBe(kind)
    expect(info.summary).toBe(summary)
    expect(info.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('identifies a subagent by agent_id, since it shares the parent session_id', () => {
    // Mérve: a subagent kérése a SZÜLŐ session_id-jával jön, csak ez különbözteti meg.
    const subagent = parsed('permissionRequest_subagent')
    const parent = parsed('permissionRequest_bash')
    expect(subagent.sessionId).toBe(parent.sessionId)
    expect(subagent.agentId).toBe('ad0b11acf46ef176e')
    expect(subagent.agentType).toBe('general-purpose')
    expect(parent.agentId).toBeUndefined()
  })

  it('flattens Claude Code\'s own rule suggestions and ignores everything but addRules', () => {
    expect(parsed('permissionRequest_bash').suggestedRules).toEqual([
      { toolName: 'Bash', ruleContent: 'echo spike-a *' },
    ])
    expect(parsed('permissionRequest_webFetch').suggestedRules).toEqual([
      { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
    ])
  })

  it('keeps an MCP suggestion without ruleContent — the rule is the tool name itself', () => {
    const [rule] = parsed('permissionRequest_mcp').suggestedRules
    expect(rule?.toolName).toBe('mcp__claude-vscode__getDiagnostics')
    expect(rule?.ruleContent).toBeUndefined()
  })

  it('offers no rule for a file write, whose suggestion is a mode change', () => {
    // A Write/Edit javaslata `setMode: acceptEdits` a sessionre, nem fájlba írható szabály.
    expect(parsed('permissionRequest_write').suggestedRules).toEqual([])
  })

  it('parses single- and multi-select questions with their options', () => {
    const { questions } = parsed('permissionRequest_askMulti')
    expect(questions.map((q) => [q.question, q.multiSelect, q.options.map((o) => o.label)])).toEqual([
      ['Milyen gyümölcsöket szeretsz?', true, ['Alma', 'Banán', 'Eper', 'Narancs']],
      ['Mi a kedvenc színed?', false, ['Piros', 'Kék', 'Zöld']],
    ])
  })

  it('carries the plan text only for ExitPlanMode', () => {
    expect(parsed('permissionRequest_plan').plan?.startsWith('# Terv: c.txt létrehozása')).toBe(true)
    expect(parsed('permissionRequest_bash').plan).toBeUndefined()
    expect(parsed('permissionRequest_bash').questions).toEqual([])
  })

  it('returns undefined for anything that is not a usable request, and never throws', () => {
    for (const garbage of [null, 42, 'x', [], {}, { session_id: 's' }, { tool_name: 'Bash' }]) {
      expect(() => parsePermissionRequest(garbage)).not.toThrow()
      expect(parsePermissionRequest(garbage)).toBeUndefined()
    }
  })

  it('tolerates a missing tool_input by summarising with the tool name', () => {
    const info = parsePermissionRequest({ session_id: 's', tool_name: 'Bash' })
    expect(info?.toolInput).toEqual({})
    expect(info?.summary).toBe('Bash')
  })
})

/** Egy Bash-kérés a megadott bemenettel — a sortörés-esetekhez nincs valódi payload. */
function bash(toolInput: Record<string, unknown>): PermissionRequestInfo | undefined {
  return parsePermissionRequest({ session_id: 's', tool_name: 'Bash', tool_input: toolInput })
}

describe('parsePermissionRequest — a parancs sortörései és a leírás', () => {
  it('keeps the line breaks of a multi-line command, normalising CRLF and trimming the ends', () => {
    // Mérve (Task 10 C): a többsoros parancs egy sorba folyt a panelen.
    const info = bash({ command: '\n  git add -A\r\n  git commit -m "x"\n\n' })
    expect(info?.summary).toBe('git add -A\n  git commit -m "x"')
  })

  it('still flattens a file path or URL to one line', () => {
    const info = parsePermissionRequest({
      session_id: 's', tool_name: 'WebFetch', tool_input: { url: ' https://example.com/\n a ' },
    })
    expect(info?.summary).toBe('https://example.com/ a')
  })

  it('carries the tool\'s own description of a command', () => {
    expect(parsed('permissionRequest_bash').description).toBe('Write spike-a to a.txt')
    expect(bash({ command: 'ls', description: '  List\nfiles ' })?.description).toBe('List files')
  })

  it('has no description where the tool gives none', () => {
    expect(parsed('permissionRequest_write').description).toBeUndefined()
    expect(parsed('permissionRequest_mcp').description).toBeUndefined()
    expect(bash({ command: 'ls', description: 42 })?.description).toBeUndefined()
  })
})

describe('parsePermissionRequest — Workflow', () => {
  function workflow(script: unknown): PermissionRequestInfo | undefined {
    return parsePermissionRequest({ session_id: 's', tool_name: 'Workflow', tool_input: { script, args: {} } })
  }

  it('summarises with the script\'s meta name and describes with its meta description', () => {
    const info = parsed('permissionRequest_workflow')
    expect(info.summary).toBe('acceptance-probe')
    expect(info.description).toBe('Run the acceptance probe in every package and summarise the results')
    expect(info.suggestedRules).toEqual([])
  })

  it('reads either quote style and an escaped quote inside the value', () => {
    const info = workflow(
      'export const meta = { name: "it\\"s-a-name", description: \'Don\\\'t panic\' }\nexport default 1',
    )
    expect(info?.summary).toBe('it"s-a-name')
    expect(info?.description).toBe("Don't panic")
  })

  it('does not take a name from outside the meta block', () => {
    // A meta-blokkban nincs név; a szkript későbbi `name:`-je nem a workflow neve.
    const info = workflow("export const meta = {\n  description: 'Only a description',\n}\nrun({ name: 'step' })")
    expect(info?.summary).toBe('Workflow')
    expect(info?.description).toBe('Only a description')
  })

  it('falls back to the tool name when the script cannot be read, and never throws', () => {
    for (const script of [undefined, 42, '', 'export default 1', 'export const meta = { name: ', null]) {
      expect(() => workflow(script)).not.toThrow()
      expect(workflow(script)?.summary).toBe('Workflow')
      expect(workflow(script)?.description).toBeUndefined()
    }
  })
})
