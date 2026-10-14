import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePermissionRequest, type PermissionRequestInfo } from './decision.js'
import {
  buildHookResponse,
  joinAnswerLabels,
  parseUserDecision,
  PLAN_APPROVAL_UNSUPPORTED,
  type DecisionResult,
} from './decision-response.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function parsed(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(fixtures[name])
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return info
}

function decisionOf(result: DecisionResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result.body.hookSpecificOutput.decision
}

const bash = parsed('permissionRequest_bash')
const write = parsed('permissionRequest_write')
const mcp = parsed('permissionRequest_mcp')
const askMulti = parsed('permissionRequest_askMulti')
const plan = parsed('permissionRequest_plan')

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
    // Mérve (K4, K5): a Claude Code egy általunk kitalált szabályt is beír, a megadott helyre.
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
