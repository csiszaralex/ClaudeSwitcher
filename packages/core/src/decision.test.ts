import { describe, expect, it } from 'vitest'
import { parsePermissionRequest, type PermissionRequestInfo } from './decision.js'
import { parsedPayload } from './testing.js'

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
    const info = parsedPayload(name)
    expect(info.toolName).toBe(toolName)
    expect(info.kind).toBe(kind)
    expect(info.summary).toBe(summary)
    expect(info.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('identifies a subagent by agent_id, since it shares the parent session_id', () => {
    // Mérve: a subagent kérése a SZÜLŐ session_id-jával jön, csak ez különbözteti meg.
    const subagent = parsedPayload('permissionRequest_subagent')
    const parent = parsedPayload('permissionRequest_bash')
    expect(subagent.sessionId).toBe(parent.sessionId)
    expect(subagent.agentId).toBe('ad0b11acf46ef176e')
    expect(subagent.agentType).toBe('general-purpose')
    expect(parent.agentId).toBeUndefined()
  })

  it('flattens Claude Code\'s own rule suggestions and ignores everything but addRules', () => {
    expect(parsedPayload('permissionRequest_bash').suggestedRules).toEqual([
      { toolName: 'Bash', ruleContent: 'echo spike-a *' },
    ])
    expect(parsedPayload('permissionRequest_webFetch').suggestedRules).toEqual([
      { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
    ])
  })

  it('keeps an MCP suggestion without ruleContent — the rule is the tool name itself', () => {
    const [rule] = parsedPayload('permissionRequest_mcp').suggestedRules
    expect(rule?.toolName).toBe('mcp__claude-vscode__getDiagnostics')
    expect(rule?.ruleContent).toBeUndefined()
  })

  it('offers no rule for a file write, whose suggestion is a mode change', () => {
    // A Write/Edit javaslata `setMode: acceptEdits` a sessionre, nem fájlba írható szabály.
    expect(parsedPayload('permissionRequest_write').suggestedRules).toEqual([])
  })

  it('parses single- and multi-select questions with their options', () => {
    const { questions } = parsedPayload('permissionRequest_askMulti')
    expect(questions.map((q) => [q.question, q.multiSelect, q.options.map((o) => o.label)])).toEqual([
      ['Milyen gyümölcsöket szeretsz?', true, ['Alma', 'Banán', 'Eper', 'Narancs']],
      ['Mi a kedvenc színed?', false, ['Piros', 'Kék', 'Zöld']],
    ])
  })

  it('carries the plan text only for ExitPlanMode', () => {
    expect(parsedPayload('permissionRequest_plan').plan?.startsWith('# Terv: c.txt létrehozása')).toBe(true)
    expect(parsedPayload('permissionRequest_bash').plan).toBeUndefined()
    expect(parsedPayload('permissionRequest_bash').questions).toEqual([])
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
    expect(parsedPayload('permissionRequest_bash').description).toBe('Write spike-a to a.txt')
    expect(bash({ command: 'ls', description: '  List\nfiles ' })?.description).toBe('List files')
  })

  it('has no description where the tool gives none', () => {
    expect(parsedPayload('permissionRequest_write').description).toBeUndefined()
    expect(parsedPayload('permissionRequest_mcp').description).toBeUndefined()
    expect(bash({ command: 'ls', description: 42 })?.description).toBeUndefined()
  })
})

describe('parsePermissionRequest — Workflow', () => {
  function workflow(script: unknown): PermissionRequestInfo | undefined {
    return parsePermissionRequest({ session_id: 's', tool_name: 'Workflow', tool_input: { script, args: {} } })
  }

  it('summarises with the script\'s meta name and describes with its meta description', () => {
    const info = parsedPayload('permissionRequest_workflow')
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

/** Egy kérés tetszőleges eszközzel és bemenettel — a formátumváltás eseteihez nincs valódi payload. */
function request(toolName: string, toolInput: unknown): PermissionRequestInfo {
  const info = parsePermissionRequest({ session_id: 's', tool_name: toolName, tool_input: toolInput })
  if (info === undefined) throw new Error(`request did not parse: ${toolName}`)
  return info
}

describe('parsePermissionRequest — olvasható-e a kérés', () => {
  it('marks every measured payload readable', () => {
    for (const name of [
      'permissionRequest_bash',
      'permissionRequest_write',
      'permissionRequest_edit',
      'permissionRequest_webFetch',
      'permissionRequest_mcp',
      'permissionRequest_askSingle',
      'permissionRequest_plan',
      'permissionRequest_subagent',
      'permissionRequest_workflow',
    ]) {
      expect(parsedPayload(name).readable, name).toBe(true)
    }
  })

  it('marks a shell request without a readable command unreadable', () => {
    for (const toolName of ['Bash', 'PowerShell']) {
      expect(request(toolName, { command: 'ls' }).readable).toBe(true)
      expect(request(toolName, {}).readable).toBe(false)
      expect(request(toolName, { command: '' }).readable).toBe(false)
      expect(request(toolName, { command: '  \n ' }).readable).toBe(false)
      expect(request(toolName, { command: ['ls'] }).readable).toBe(false)
      expect(request(toolName, { cmd: 'ls' }).readable).toBe(false)
    }
    expect(parsePermissionRequest({ session_id: 's', tool_name: 'Bash' })?.readable).toBe(false)
  })

  it('marks a file write without its path unreadable', () => {
    for (const toolName of ['Write', 'Edit', 'MultiEdit']) {
      expect(request(toolName, { file_path: 'a.txt' }).readable).toBe(true)
      expect(request(toolName, { path: 'a.txt' }).readable).toBe(false)
      expect(request(toolName, { file_path: '' }).readable).toBe(false)
    }
  })

  it('reads a notebook edit by notebook_path, and summarises with it', () => {
    const notebook = request('NotebookEdit', { notebook_path: 'P:/nb/a.ipynb', new_source: 'x' })
    expect(notebook.readable).toBe(true)
    expect(notebook.summary).toBe('P:/nb/a.ipynb')
    expect(request('NotebookEdit', { file_path: 'P:/nb/a.ipynb' }).readable).toBe(false)
  })

  it('marks a WebFetch without a url unreadable', () => {
    expect(request('WebFetch', { url: 'https://x' }).readable).toBe(true)
    expect(request('WebFetch', { prompt: 'p' }).readable).toBe(false)
  })

  it('keeps every other tool readable, even with an empty input', () => {
    expect(request('mcp__github__create_issue', {}).readable).toBe(true)
    expect(request('Grep', { pattern: 'x' }).readable).toBe(true)
    expect(request('SomethingNew', 'garbage').readable).toBe(true)
  })
})

describe('parsePermissionRequest — a szabályjavaslatok', () => {
  const suggesting = (permission_suggestions: unknown): PermissionRequestInfo => {
    const info = parsePermissionRequest({
      session_id: 's',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      permission_suggestions,
    })
    if (info === undefined) throw new Error('request did not parse')
    return info
  }

  it('takes only allow suggestions', () => {
    expect(
      suggesting([
        { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash', ruleContent: 'rm *' }], destination: 'localSettings' },
        { type: 'addRules', behavior: 'ask', rules: [{ toolName: 'Bash', ruleContent: 'git *' }], destination: 'localSettings' },
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cat *' }], destination: 'localSettings' },
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }], destination: 'localSettings' },
      ]).suggestedRules,
    ).toEqual([{ toolName: 'Bash', ruleContent: 'ls *' }])
  })

  it('drops a rule whose ruleContent is empty or not text instead of widening it to the bare tool', () => {
    expect(
      suggesting([
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            { toolName: 'Bash', ruleContent: '' },
            { toolName: 'Bash', ruleContent: 42 },
            { toolName: 'Bash', ruleContent: null },
            { toolName: 'mcp__x__y' },
          ],
          destination: 'localSettings',
        },
      ]).suggestedRules,
    ).toEqual([{ toolName: 'mcp__x__y', ruleContent: undefined }])
  })
})
