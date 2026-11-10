import { describe, expect, it } from 'vitest'
import { parsePermissionRequest } from './decision.js'
import {
  buildHookResponse,
  joinAnswerLabels,
  parseUserDecision,
  PLAN_APPROVAL_UNSUPPORTED,
  UNREADABLE_REQUEST,
  type DecisionResult,
  type UserDecision,
} from './decision-response.js'
import { hookPayload, parsedPayload } from './testing.js'

function decisionOf(result: DecisionResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result.body.hookSpecificOutput.decision
}

const bash = parsedPayload('permissionRequest_bash')
const write = parsedPayload('permissionRequest_write')
const mcp = parsedPayload('permissionRequest_mcp')
const askMulti = parsedPayload('permissionRequest_askMulti')
const plan = parsedPayload('permissionRequest_plan')

describe('buildHookResponse', () => {
  it('wraps every decision in the measured PermissionRequest envelope', () => {
    const result = buildHookResponse(bash, { type: 'allow' })
    expect(result).toEqual({
      ok: true,
      body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    })
  })

  it('refuses a bare allow for a question — it would continue without an answer', () => {
    expect(buildHookResponse(askMulti, { type: 'allow' }).ok).toBe(false)
  })

  it('refuses to approve a plan, which Claude Code ignores from a hook', () => {
    expect(buildHookResponse(plan, { type: 'allow' })).toEqual({ ok: false, reason: PLAN_APPROVAL_UNSUPPORTED })
  })

  it('denies with the trimmed message the model will read, or without one', () => {
    expect(decisionOf(buildHookResponse(bash, { type: 'deny', message: '  ne töröld  ' }))).toEqual({
      behavior: 'deny',
      message: 'ne töröld',
    })
    expect(decisionOf(buildHookResponse(bash, { type: 'deny' }))).toEqual({ behavior: 'deny' })
    expect(decisionOf(buildHookResponse(bash, { type: 'deny', message: '   ' }))).toEqual({ behavior: 'deny' })
  })

  it('rejects a plan only with feedback, because the session replans from it', () => {
    expect(buildHookResponse(plan, { type: 'deny' }).ok).toBe(false)
    expect(decisionOf(buildHookResponse(plan, { type: 'deny', message: 'a fájl neve más legyen' }))).toEqual({
      behavior: 'deny',
      message: 'a fájl neve más legyen',
    })
  })

  it('adds an edited rule at machine level, exactly as given', () => {
    // Measured (spike K4, K5): Claude Code writes even a rule we made up, to the given destination.
    const decision = decisionOf(
      buildHookResponse(bash, {
        type: 'allow-with-rules',
        rules: [{ toolName: 'Bash', ruleContent: 'echo spike-a > a.txt' }],
        destination: 'userSettings',
      }),
    )
    expect(decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'echo spike-a > a.txt' }],
          behavior: 'allow',
          destination: 'userSettings',
        },
      ],
    })
  })

  it('omits ruleContent for an MCP rule instead of sending it as undefined', () => {
    const result = buildHookResponse(mcp, {
      type: 'allow-with-rules',
      rules: [{ toolName: 'mcp__claude-vscode__getDiagnostics' }],
      destination: 'localSettings',
    })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('ruleContent')
  })

  it('refuses rules for a file write, and an empty rule list for anything', () => {
    expect(
      buildHookResponse(write, { type: 'allow-with-rules', rules: [{ toolName: 'Write' }], destination: 'localSettings' }).ok,
    ).toBe(false)
    expect(buildHookResponse(bash, { type: 'allow-with-rules', rules: [], destination: 'localSettings' }).ok).toBe(false)
  })

  it('switches the session to accept edits only for a file write', () => {
    expect(decisionOf(buildHookResponse(write, { type: 'allow-session-edits' }))).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(buildHookResponse(bash, { type: 'allow-session-edits' }).ok).toBe(false)
  })

  it('answers every question, keeping the original questions in updatedInput', () => {
    const answers = { 'Milyen gyümölcsöket szeretsz?': 'Alma, Banán', 'Mi a kedvenc színed?': 'levendula' }
    const decision = decisionOf(buildHookResponse(askMulti, { type: 'answer', answers }))
    expect(decision['behavior']).toBe('allow')
    expect(decision['updatedInput']).toEqual({ ...askMulti.toolInput, answers })
  })

  it('refuses an answer that leaves a question blank, or an answer to a non-question', () => {
    expect(
      buildHookResponse(askMulti, { type: 'answer', answers: { 'Milyen gyümölcsöket szeretsz?': 'Alma' } }).ok,
    ).toBe(false)
    expect(buildHookResponse(bash, { type: 'answer', answers: {} }).ok).toBe(false)
  })

  it('refuses any answer when the questions could not be read — never an allow with no answers', () => {
    // If the shape of `tool_input.questions` changes, the parser drops everything and the list is
    // empty. The per-question check would then refuse nothing.
    const raw = hookPayload('permissionRequest_askMulti')
    const unknownShape = parsePermissionRequest({
      ...raw,
      tool_input: { questions: [{ prompt: 'Milyen gyümölcsöket szeretsz?', choices: ['Alma'] }] },
    })
    if (unknownShape === undefined) throw new Error('payload did not parse')
    expect(unknownShape.kind).toBe('question')
    expect(unknownShape.questions).toEqual([])

    expect(buildHookResponse(unknownShape, { type: 'answer', answers: {} }).ok).toBe(false)
    expect(
      buildHookResponse(unknownShape, { type: 'answer', answers: { 'Milyen gyümölcsöket szeretsz?': 'Alma' } }).ok,
    ).toBe(false)
    // The way out: a deny with a message still goes through.
    expect(decisionOf(buildHookResponse(unknownShape, { type: 'deny', message: 'a VSCode-ban válaszolok' }))).toEqual({
      behavior: 'deny',
      message: 'a VSCode-ban válaszolok',
    })
  })

  it('refuses an answer with a key that is not one of the questions', () => {
    const answers = {
      'Milyen gyümölcsöket szeretsz?': 'Alma',
      'Mi a kedvenc színed?': 'kék',
      'Ilyen kérdés nincs': 'mégis',
    }
    expect(buildHookResponse(askMulti, { type: 'answer', answers }).ok).toBe(false)
  })
})

describe('joinAnswerLabels', () => {
  it('joins with comma and space, the documented multi-select form', () => {
    expect(joinAnswerLabels(['Alma', 'Banán'])).toBe('Alma, Banán')
  })
})

describe('parseUserDecision — the IPC boundary', () => {
  it('accepts each well-formed decision', () => {
    expect(parseUserDecision({ type: 'allow' })).toEqual({ type: 'allow' })
    expect(parseUserDecision({ type: 'deny', message: 'x' })).toEqual({ type: 'deny', message: 'x' })
    expect(parseUserDecision({ type: 'deny' })).toEqual({ type: 'deny' })
    expect(parseUserDecision({ type: 'allow-session-edits' })).toEqual({ type: 'allow-session-edits' })
    expect(
      parseUserDecision({ type: 'allow-with-rules', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }] }),
    ).toEqual({ type: 'allow-with-rules', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }] })
    expect(parseUserDecision({ type: 'answer', answers: { q: 'a' } })).toEqual({ type: 'answer', answers: { q: 'a' } })
  })

  it('rejects anything malformed, and never throws', () => {
    for (const garbage of [
      null,
      'allow',
      { type: 'approve' },
      { type: 'deny', message: 7 },
      { type: 'allow-with-rules', destination: 'projectSettings', rules: [] },
      { type: 'allow-with-rules', destination: 'userSettings', rules: [{ ruleContent: 'x' }] },
      { type: 'answer', answers: { q: 1 } },
      { type: 'answer', answers: [] },
    ]) {
      expect(() => parseUserDecision(garbage)).not.toThrow()
      expect(parseUserDecision(garbage)).toBeUndefined()
    }
  })
})

describe('buildHookResponse: unreadable request', () => {
  const blindBash = parsePermissionRequest({ session_id: 's', tool_name: 'Bash', tool_input: { cmd: 'rm -rf /' } })
  const blindEdit = parsePermissionRequest({ session_id: 's', tool_name: 'Edit', tool_input: { path: 'x' } })
  if (blindBash === undefined || blindEdit === undefined) throw new Error('payload did not parse')

  it('refuses every allow variant, since the panel cannot show what would be approved', () => {
    const rules: UserDecision = { type: 'allow-with-rules', rules: [{ toolName: 'Bash' }], destination: 'localSettings' }
    for (const result of [
      buildHookResponse(blindBash, { type: 'allow' }),
      buildHookResponse(blindBash, rules),
      buildHookResponse(blindEdit, { type: 'allow' }),
      buildHookResponse(blindEdit, { type: 'allow-session-edits' }),
    ]) {
      expect(result).toEqual({ ok: false, reason: UNREADABLE_REQUEST })
    }
  })

  it('still lets the user deny it', () => {
    expect(decisionOf(buildHookResponse(blindBash, { type: 'deny' }))).toEqual({ behavior: 'deny' })
    expect(decisionOf(buildHookResponse(blindEdit, { type: 'deny', message: 'nem' }))).toEqual({
      behavior: 'deny',
      message: 'nem',
    })
  })
})
