import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './testing.js'
import { CONVERSATION_TURNS, conversationFromLines } from './conversation.js'
import {
  findTranscriptPath,
  readActivityFromLines,
  readTranscriptActivity,
  readTranscriptConversation,
  tailLines,
} from './transcript.js'

const assistantText = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-04T10:00:00.000Z',
  message: { content: [{ type: 'text', text: 'Megnézem a konfigot.' }] },
})

const assistantTool = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-04T10:00:05.000Z',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
})

describe('readActivityFromLines', () => {
  it('returns the last assistant text', () => {
    const a = readActivityFromLines([assistantText])
    expect(a.lastAssistantText).toBe('Megnézem a konfigot.')
    expect(a.lastEventAt).toBe(Date.parse('2026-09-04T10:00:00.000Z'))
  })

  it('reports a running tool from the newest assistant message', () => {
    const a = readActivityFromLines([assistantText, assistantTool])
    expect(a.runningTool).toBe('Bash')
    expect(a.lastAssistantText).toBe('Megnézem a konfigot.')
  })

  it('clears the running tool once its result arrives', () => {
    const result = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-04T10:00:09.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] },
    })
    const a = readActivityFromLines([assistantTool, result])
    expect(a.runningTool).toBeUndefined()
  })

  it('skips unknown record types without throwing', () => {
    const noise = [
      JSON.stringify({ type: 'queue-operation', operation: 'x' }),
      JSON.stringify({ type: 'atis-latch', atis: 1 }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'x' }),
      JSON.stringify({ type: 'attachment', attachment: {} }),
      JSON.stringify({ type: 'brand-new-type-from-the-future' }),
    ]
    expect(() => readActivityFromLines(noise)).not.toThrow()
    expect(readActivityFromLines(noise).lastAssistantText).toBeUndefined()
  })

  it('skips malformed JSON and truncated lines', () => {
    const a = readActivityFromLines(['{"type":"assis', '', '   ', assistantText])
    expect(a.lastAssistantText).toBe('Megnézem a konfigot.')
  })

  it('returns an empty activity for no input', () => {
    expect(readActivityFromLines([])).toEqual({})
  })

  it('survives a null entry inside a content array', () => {
    // Valid JSON, and reading `.type` on it would throw a TypeError. This kind of surprise is why
    // this module is tolerant at all.
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-04T10:00:00.000Z',
      message: { content: [null, { type: 'text', text: 'túléltem' }] },
    })
    expect(() => readActivityFromLines([line])).not.toThrow()
    expect(readActivityFromLines([line]).lastAssistantText).toBe('túléltem')
  })

  it('survives content blocks that are primitives', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [42, 'szöveg', true, { type: 'text', text: 'ok' }] },
    })
    expect(readActivityFromLines([line]).lastAssistantText).toBe('ok')
  })

  it('survives a message whose content is not an array', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: 'plain string' } }),
      JSON.stringify({ type: 'assistant', message: 'not an object' }),
      JSON.stringify({ type: 'assistant', message: null }),
    ]
    expect(() => readActivityFromLines(lines)).not.toThrow()
    expect(readActivityFromLines(lines)).toEqual({})
  })

  it('keeps the last tool when one message carries several tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: {} },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    })
    expect(readActivityFromLines([line]).runningTool).toBe('Bash')
  })

  it('carries a short detail of what the running tool works on', () => {
    expect(readActivityFromLines([assistantTool]).toolDetail).toBe('pnpm test')
  })

  it('takes the detail from the same block as the running tool', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'createPanel' } },
        ],
      },
    })
    const a = readActivityFromLines([line])
    expect(a.runningTool).toBe('Grep')
    expect(a.toolDetail).toBe('createPanel')
  })

  it('drops a stale detail when the next tool has none', () => {
    const bare = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: {} }] } })
    const a = readActivityFromLines([assistantTool, bare])
    expect(a.runningTool).toBe('TodoWrite')
    expect(a.toolDetail).toBeUndefined()
  })

  it('clears the detail together with the running tool', () => {
    const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } })
    expect(readActivityFromLines([assistantTool, result]).toolDetail).toBeUndefined()
  })

  it('reads a subagent transcript, skipping its non-message lines', () => {
    // Constructed lines in the measured subagent shape: agentId, isSidechain, and api-request noise.
    const sidechain = { agentId: 'a1', isSidechain: true, sessionId: 'sid-1' }
    const lines = [
      JSON.stringify({ ...sidechain, type: 'api-request', timestamp: '2026-10-21T10:00:00.000Z', request: {} }),
      JSON.stringify({
        ...sidechain,
        type: 'assistant',
        timestamp: '2026-10-21T10:00:01.000Z',
        message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'createPanel' } }] },
      }),
      JSON.stringify({ ...sidechain, type: 'api-request', timestamp: '2026-10-21T10:00:02.000Z' }),
    ]
    const a = readActivityFromLines(lines)
    expect(a.runningTool).toBe('Grep')
    expect(a.toolDetail).toBe('createPanel')
  })
})

describe('readActivityFromLines: the usage limit', () => {
  // An invented record in the measured shape (Claude Code 2.1.326, design doc "The usage limit
  // record"): ids, paths and the session left out, the times made up.
  const resetsAtSeconds = 1_800_000_000
  const info = {
    status: 'rejected',
    resetsAt: resetsAtSeconds,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
  }
  const limitRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'assistant',
    isSidechain: false,
    timestamp: '2026-09-04T10:01:00.000Z',
    message: {
      model: '<synthetic>',
      role: 'assistant',
      type: 'message',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 3pm (Europe/Budapest)" }],
    },
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: info },
    quotaLimits: info,
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    apiErrorType: 'rate_limit_error',
    ...overrides,
  })
  const line = (overrides: Record<string, unknown> = {}): string => JSON.stringify(limitRecord(overrides))

  it('reads the kind and the reset time (in ms) of the limit record', () => {
    const a = readActivityFromLines([assistantText, line()])
    expect(a.usageLimit).toEqual({ kind: 'five_hour', resetsAt: resetsAtSeconds * 1000 })
    expect(a.lastEventAt).toBe(Date.parse('2026-09-04T10:01:00.000Z'))
  })

  it('does not take the limit text as the last assistant text', () => {
    expect(readActivityFromLines([assistantText, line()]).lastAssistantText).toBe('Megnézem a konfigot.')
  })

  it('keeps the text of another synthetic error record', () => {
    const serverError = JSON.stringify({
      type: 'assistant',
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] },
      error: 'server_error',
      isApiErrorMessage: true,
    })
    const a = readActivityFromLines([serverError])
    expect(a.lastAssistantText).toBe('API Error: 500')
    expect(a.usageLimit).toBeUndefined()
  })

  it('reads the weekly limit, and a record with quotaLimits only', () => {
    // The 2.1.268 records carry no apiError and no apiErrorParams.
    const weekly = { ...info, rateLimitType: 'seven_day' }
    const a = readActivityFromLines([line({ quotaLimits: weekly, apiErrorParams: undefined, apiError: undefined })])
    expect(a.usageLimit).toEqual({ kind: 'seven_day', resetsAt: resetsAtSeconds * 1000 })
  })

  it('falls back to apiErrorParams.rate_limit_info without quotaLimits', () => {
    const a = readActivityFromLines([line({ quotaLimits: undefined })])
    expect(a.usageLimit).toEqual({ kind: 'five_hour', resetsAt: resetsAtSeconds * 1000 })
  })

  it('keeps an unknown kind as raw text, and drops a missing or invalid one', () => {
    const kindOf = (rateLimitType: unknown): string | undefined =>
      readActivityFromLines([line({ quotaLimits: { ...info, rateLimitType } })]).usageLimit?.kind
    expect(kindOf('opus_weekly')).toBe('opus_weekly')
    expect(kindOf(undefined)).toBeUndefined()
    expect(kindOf(42)).toBeUndefined()
    expect(kindOf('')).toBeUndefined()
  })

  it('drops a missing or invalid reset time but keeps the limit', () => {
    for (const resetsAt of [undefined, '1800000000', -5, 0, null]) {
      const a = readActivityFromLines([line({ quotaLimits: { ...info, resetsAt }, apiErrorParams: undefined })])
      expect(a.usageLimit).toEqual({ kind: 'five_hour', resetsAt: undefined })
    }
  })

  it('ignores a limit that is not rejected, or a record that is not an API error', () => {
    const allowed = { ...info, status: 'allowed' }
    expect(readActivityFromLines([line({ quotaLimits: allowed, apiErrorParams: { rate_limit_info: allowed } })]).usageLimit).toBeUndefined()
    expect(readActivityFromLines([line({ isApiErrorMessage: undefined })]).usageLimit).toBeUndefined()
    expect(readActivityFromLines([line({ isApiErrorMessage: 'true' })]).usageLimit).toBeUndefined()
    expect(readActivityFromLines([line({ quotaLimits: 'rejected', apiErrorParams: null })]).usageLimit).toBeUndefined()
    expect(readActivityFromLines([line({ type: 'user' })]).usageLimit).toBeUndefined()
  })

  it('is cleared by a later user record', () => {
    const prompt = JSON.stringify({ type: 'user', message: { content: 'folytasd' } })
    expect(readActivityFromLines([line(), prompt]).usageLimit).toBeUndefined()
  })

  it('is cleared by a later real answer, not by another error record or other record types', () => {
    const serverError = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [] } })
    const noise = JSON.stringify({ type: 'queue-operation', operation: 'enqueue' })
    expect(readActivityFromLines([line(), serverError, noise]).usageLimit).toBeDefined()
    expect(readActivityFromLines([line(), assistantText]).usageLimit).toBeUndefined()
  })
})

describe('readActivityFromLines: the tab title', () => {
  const sessionId = '5b0d7c1e-3f2a-4c8b-9e6d-1a2b3c4d5e6f'
  const ai = (aiTitle: unknown): string => JSON.stringify({ type: 'ai-title', aiTitle, sessionId })
  const custom = (customTitle: unknown): string => JSON.stringify({ type: 'custom-title', customTitle, sessionId })
  const lastPrompt = JSON.stringify({ type: 'last-prompt', lastPrompt: 'futtasd a teszteket', sessionId })

  it('takes the latest AI title', () => {
    expect(readActivityFromLines([ai('Fix the parser'), assistantText, ai('Fix the parser tests'), lastPrompt]).tabTitle).toBe(
      'Fix the parser tests',
    )
  })

  it('prefers the custom title, even when AI titles come after it', () => {
    const a = readActivityFromLines([ai('Fix the parser'), custom('Parser munka'), assistantText, ai('Fix the parser tests')])
    expect(a.tabTitle).toBe('Parser munka')
  })

  it('takes the latest custom title', () => {
    expect(readActivityFromLines([custom('Első név'), ai('Something'), custom('Második név')]).tabTitle).toBe('Második név')
  })

  it('has no tab title without a title record', () => {
    expect(readActivityFromLines([assistantText, lastPrompt]).tabTitle).toBeUndefined()
    expect('tabTitle' in readActivityFromLines([assistantText])).toBe(false)
  })

  it('skips a title that is not a non-blank string', () => {
    for (const bad of ['', '   ', 42, null, undefined, { text: 'x' }]) {
      expect(readActivityFromLines([ai(bad)]).tabTitle).toBeUndefined()
      expect(readActivityFromLines([ai('Kept title'), custom(bad)]).tabTitle).toBe('Kept title')
      expect(readActivityFromLines([custom('Kept name'), custom(bad)]).tabTitle).toBe('Kept name')
    }
  })

  it('does not let a title record change the other fields', () => {
    const a = readActivityFromLines([assistantTool, ai('Run the tests')])
    expect(a.runningTool).toBe('Bash')
    expect(a.lastAssistantText).toBeUndefined()
    expect(a.lastEventAt).toBe(Date.parse('2026-09-04T10:00:05.000Z'))
  })
})

// Invented records in the measured shapes (Claude Code 2.1.325, design doc "Cross-session
// messages"): the pipes, ids, names and texts are made up.
const PIPE_A = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
const PIPE_B = String.raw`\\.\pipe\LOCAL\cc-msg-f9e8d7c6b5a4938271605f4e3d2c1b0a`
const prompting = { sessionId: '7d2e9a40-1c3b-4f5e-8a6d-2b1c0e9f8a7d', timestamp: '2026-11-19T10:00:00.000Z' }
const header = (pipe: string, name: string): string =>
  `<cross-session-message from="uds:${pipe}" hop-chain="aa11bb22cc33dd44" from-name="${name}" from-mode="prompting">\nNézd meg a hibát.`
const enqueued = (pipe: string, name: string): string =>
  JSON.stringify({ ...prompting, type: 'queue-operation', operation: 'enqueue', content: header(pipe, name) })
const dequeued = JSON.stringify({ ...prompting, type: 'queue-operation', operation: 'dequeue' })
const origin = (pipe: string, name: string): Record<string, unknown> => ({
  kind: 'peer',
  from: `uds:${pipe}`,
  msg_id: '3f1e2d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
  name,
  fromMode: 'prompting',
  body: 'Nézd meg a hibát.',
})
/** The idle recipient's delivery: a meta `user` record that starts the turn. */
const delivered = (pipe: string, name: string): string =>
  JSON.stringify({ ...prompting, type: 'user', isMeta: true, message: { role: 'user', content: header(pipe, name) }, origin: origin(pipe, name) })
/** The busy recipient's delivery: a `queued_command` attachment that joins the running turn. */
const absorbed = (pipe: string, name: string): string =>
  JSON.stringify({
    ...prompting,
    type: 'attachment',
    attachment: { type: 'queued_command', prompt: header(pipe, name), commandMode: 'prompt', origin: origin(pipe, name) },
  })
const removed = JSON.stringify({ ...prompting, type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' })
const endTurn = JSON.stringify({
  ...prompting,
  type: 'assistant',
  message: { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Kész, visszaírtam.' }] },
})
const toolTurn = JSON.stringify({
  ...prompting,
  type: 'assistant',
  message: { model: 'claude-x', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
})

describe('readActivityFromLines: who prompted the session', () => {
  const pipes = (lines: string[], earlier: string[] = []): string[] | undefined =>
    readActivityFromLines(lines, earlier).promptedBy?.map((sender) => sender.pipe)

  it('names an idle recipient sender from its arrival until the end of the turn that handles it', () => {
    expect(readActivityFromLines([enqueued(PIPE_A, 'Orchestrator')]).promptedBy).toEqual([{ pipe: PIPE_A, name: 'Orchestrator' }])
    expect(pipes([enqueued(PIPE_A, 'Orchestrator'), dequeued, delivered(PIPE_A, 'Orchestrator'), toolTurn])).toEqual([PIPE_A])
    expect(readActivityFromLines([enqueued(PIPE_A, 'Orchestrator'), dequeued, delivered(PIPE_A, 'Orchestrator'), toolTurn, endTurn]).promptedBy).toBeUndefined()
  })

  it('keeps a message queued behind a running turn pending across that turn end', () => {
    // The message came while the session worked on something else, and that turn ended before it was taken up.
    const queued = [toolTurn, enqueued(PIPE_A, 'Orchestrator'), endTurn]
    expect(pipes(queued)).toEqual([PIPE_A])
    expect(pipes([...queued, dequeued, delivered(PIPE_A, 'Orchestrator'), toolTurn])).toEqual([PIPE_A])
    expect(pipes([...queued, dequeued, delivered(PIPE_A, 'Orchestrator'), toolTurn, endTurn])).toBeUndefined()
  })

  it('names the sender of a message absorbed by the running turn until that turn ends', () => {
    const lines = [toolTurn, enqueued(PIPE_A, 'Orchestrator'), absorbed(PIPE_A, 'Orchestrator'), removed, toolTurn]
    expect(pipes(lines)).toEqual([PIPE_A])
    expect(pipes([...lines, endTurn])).toBeUndefined()
  })

  it('ends the turn at a synthetic record too', () => {
    const synthetic = JSON.stringify({
      ...prompting,
      type: 'assistant',
      isApiErrorMessage: true,
      message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error' }] },
    })
    expect(pipes([dequeued, delivered(PIPE_A, 'Orchestrator'), synthetic])).toBeUndefined()
  })

  it('gives one entry per sender, with several senders at once', () => {
    const lines = [
      delivered(PIPE_A, 'Orchestrator'),
      toolTurn,
      enqueued(PIPE_B, 'Reviewer'),
      absorbed(PIPE_B, 'Reviewer'),
      enqueued(PIPE_A, 'Orchestrator'),
      absorbed(PIPE_A, 'Orchestrator'),
    ]
    expect(readActivityFromLines(lines).promptedBy).toEqual([
      { pipe: PIPE_A, name: 'Orchestrator' },
      { pipe: PIPE_B, name: 'Reviewer' },
    ])
  })

  it('keeps the latest name, and a sender without one', () => {
    const renamed = [delivered(PIPE_A, 'Old name'), absorbed(PIPE_A, 'New name')]
    expect(readActivityFromLines(renamed).promptedBy).toEqual([{ pipe: PIPE_A, name: 'New name' }])
    const nameless = JSON.stringify({ ...prompting, type: 'queue-operation', operation: 'enqueue', content: `<cross-session-message from="uds:${PIPE_A}" from-mode="prompting">\nszia` })
    expect(readActivityFromLines([nameless]).promptedBy).toEqual([{ pipe: PIPE_A }])
  })

  it('ignores a subagent handback, a plain queued prompt and a sender that is no pipe', () => {
    const handback = JSON.stringify({
      ...prompting,
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: '<agent-message from="0a1b2c3d4e5f60718">kész</agent-message>',
        origin: { kind: 'peer', from: '0a1b2c3d4e5f60718', senderTaskId: 'task-1', name: 'worker', handback: true },
      },
    })
    const plainPrompt = JSON.stringify({ ...prompting, type: 'queue-operation', operation: 'enqueue', content: 'futtasd a teszteket' })
    const humanCommand = JSON.stringify({ ...prompting, type: 'attachment', attachment: { type: 'queued_command', prompt: 'és a lintet is', origin: { kind: 'human' } } })
    const noPipe = JSON.stringify({ ...prompting, type: 'queue-operation', operation: 'enqueue', content: '<cross-session-message from="uds:" from-name="X">\nszia' })
    expect(readActivityFromLines([toolTurn, handback, plainPrompt, humanCommand, noPipe]).promptedBy).toBeUndefined()
  })

  it('reads the earlier lines only for the senders', () => {
    expect(pipes([toolTurn], [delivered(PIPE_A, 'Orchestrator')])).toEqual([PIPE_A])
    expect(pipes([toolTurn], [delivered(PIPE_A, 'Orchestrator'), endTurn])).toBeUndefined()
    // The earlier end turn's text does not become the row's text.
    expect(readActivityFromLines([toolTurn], [endTurn]).lastAssistantText).toBeUndefined()
  })

  it('leaves the other fields as they were', () => {
    const a = readActivityFromLines([delivered(PIPE_A, 'Orchestrator'), toolTurn])
    expect(a.runningTool).toBe('Bash')
    expect(a.toolDetail).toBe('pnpm test')
  })
})

describe('readActivityFromLines: the last own prompt', () => {
  // Invented records in the measured shapes (design doc "Auto-accept per session"); the times are made up.
  const at = (minute: number): string => `2026-11-28T09:${String(minute).padStart(2, '0')}:00.000Z`
  const ms = (minute: number): number => Date.parse(at(minute))
  const own = (minute: number): string =>
    JSON.stringify({ ...prompting, timestamp: at(minute), type: 'user', message: { role: 'user', content: 'Futtasd a teszteket.' }, origin: { kind: 'human' } })
  const ownQueued = (minute: number): string =>
    JSON.stringify({
      ...prompting,
      timestamp: at(minute),
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'és a lintet is', commandMode: 'prompt', origin: { kind: 'human' } },
    })
  const later = (line: string, minute: number): string => JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), timestamp: at(minute) })
  const toolResult = (minute: number): string =>
    JSON.stringify({
      ...prompting,
      timestamp: at(minute),
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'kimenet' }] },
      toolUseResult: { stdout: 'kimenet' },
    })
  const command = (minute: number): string =>
    JSON.stringify({
      ...prompting,
      timestamp: at(minute),
      type: 'user',
      message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' },
    })
  const commandOutput = (minute: number): string =>
    JSON.stringify({ ...prompting, timestamp: at(minute), type: 'user', message: { role: 'user', content: '<local-command-stdout>Kész</local-command-stdout>' } })

  it('keeps the time of the latest own prompt, a typed one and one that joined the running turn', () => {
    expect(readActivityFromLines([own(1), toolTurn]).lastOwnPromptAt).toBe(ms(1))
    expect(readActivityFromLines([own(1), later(toolTurn, 2), ownQueued(3), later(toolTurn, 4)]).lastOwnPromptAt).toBe(ms(3))
  })

  it('does not count a cross-session message, a tool result, a slash command or its output', () => {
    const lines = [
      own(1),
      later(delivered(PIPE_A, 'Orchestrator'), 2),
      later(absorbed(PIPE_A, 'Orchestrator'), 3),
      toolResult(4),
      command(5),
      commandOutput(6),
    ]
    expect(readActivityFromLines(lines).lastOwnPromptAt).toBe(ms(1))
    expect('lastOwnPromptAt' in readActivityFromLines(lines.slice(1))).toBe(false)
  })

  it('does not count a meta or compacted user record', () => {
    const meta = JSON.stringify({ ...JSON.parse(own(2)) as Record<string, unknown>, isMeta: true })
    const compacted = JSON.stringify({ ...JSON.parse(own(3)) as Record<string, unknown>, isCompactSummary: true })
    expect(readActivityFromLines([own(1), meta, compacted]).lastOwnPromptAt).toBe(ms(1))
  })
})

describe('readTranscriptActivity', () => {
  const TAIL = 256 * 1024
  // A tool result of about 2 KB that holds none of the cross-session markers.
  const filler = JSON.stringify({ ...prompting, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok '.repeat(700) }] } })
  const fillerOf = (bytes: number): string[] => Array.from({ length: Math.ceil(bytes / (filler.length + 1)) }, () => filler)

  async function transcriptOf(lines: string[]): Promise<string> {
    const file = path.join(await tempDir('cs-activity-'), 'transcript.jsonl')
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
    return file
  }

  it('reads a small transcript as readActivityFromLines does', async () => {
    const lines = [delivered(PIPE_A, 'Orchestrator'), toolTurn]
    expect(await readTranscriptActivity(await transcriptOf(lines))).toEqual(readActivityFromLines(lines))
  })

  it('finds the sender of a turn that outgrew the tail, which the tail alone loses', async () => {
    const file = await transcriptOf([endTurn, dequeued, delivered(PIPE_A, 'Orchestrator'), ...fillerOf(1.5 * 1024 * 1024), toolTurn])
    expect(readActivityFromLines(await tailLines(file)).promptedBy).toBeUndefined()
    const a = await readTranscriptActivity(file)
    expect(a.promptedBy).toEqual([{ pipe: PIPE_A, name: 'Orchestrator' }])
    expect(a.runningTool).toBe('Bash')
  })

  it('finds a delivery whose line runs across the start of the tail', async () => {
    const delivery = delivered(PIPE_A, 'Orchestrator')
    // One ASCII line after the delivery, so long that the 256 KB tail starts halfway into the delivery line.
    const restBytes = TAIL - Math.floor(Buffer.byteLength(delivery) / 2)
    const pad = (body: number): string => JSON.stringify({ type: 'pad', x: 'p'.repeat(body) })
    const rest = `${pad(restBytes - pad(0).length - 1)}\n`
    expect(Buffer.byteLength(rest)).toBe(restBytes)
    const file = path.join(await tempDir('cs-activity-'), 'transcript.jsonl')
    await writeFile(file, `${fillerOf(4096).join('\n')}\n${delivery}\n${rest}`, 'utf8')
    expect(readActivityFromLines(await tailLines(file)).promptedBy).toBeUndefined()
    expect((await readTranscriptActivity(file)).promptedBy).toEqual([{ pipe: PIPE_A, name: 'Orchestrator' }])
  })

  it('does not look back past a turn end in the tail', async () => {
    const file = await transcriptOf([delivered(PIPE_A, 'Orchestrator'), ...fillerOf(TAIL * 2), endTurn])
    expect((await readTranscriptActivity(file)).promptedBy).toBeUndefined()
  })

  it('stops at the last turn end before the tail', async () => {
    const file = await transcriptOf([delivered(PIPE_B, 'Reviewer'), endTurn, ...fillerOf(TAIL), delivered(PIPE_A, 'Orchestrator'), ...fillerOf(TAIL * 2)])
    expect((await readTranscriptActivity(file)).promptedBy).toEqual([{ pipe: PIPE_A, name: 'Orchestrator' }])
  })

  it('looks back at most lookbackBytes', async () => {
    const file = await transcriptOf([delivered(PIPE_A, 'Orchestrator'), ...fillerOf(TAIL * 3)])
    expect((await readTranscriptActivity(file, TAIL)).promptedBy).toBeUndefined()
    expect((await readTranscriptActivity(file, TAIL * 4)).promptedBy).toEqual([{ pipe: PIPE_A, name: 'Orchestrator' }])
  })

  it('returns nothing for a file that does not exist', async () => {
    expect(await readTranscriptActivity(path.join(tmpdir(), 'cs-nope', 'missing.jsonl'))).toEqual({})
  })
})

describe('readTranscriptConversation', () => {
  const ask = (text: string): string =>
    JSON.stringify({ ...prompting, type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } })
  // A tool result of about 2 KB: no conversation entry, kept out by the line pre-filter.
  const filler = JSON.stringify({ ...prompting, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok '.repeat(700) }] }, toolUseResult: {} })
  const fillerOf = (bytes: number): string[] => Array.from({ length: Math.ceil(bytes / (filler.length + 1)) }, () => filler)

  async function transcriptOf(lines: string[]): Promise<string> {
    const file = path.join(await tempDir('cs-conversation-'), 'transcript.jsonl')
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
    return file
  }

  it('reads a small transcript as conversationFromLines does', async () => {
    const lines = [ask('Szia.'), endTurn, delivered(PIPE_A, 'Orchestrator'), toolTurn]
    const entries = await readTranscriptConversation(await transcriptOf(lines))
    expect(entries).toEqual(conversationFromLines(lines))
    expect(entries?.map((entry) => entry.kind)).toEqual(['prompt', 'answer', 'message', 'tool'])
  })

  it('reads back across pieces until the last turns start, with every line intact', async () => {
    // More turns than shown, each with about 300 KB of tool results, so the read spans several 1 MB
    // pieces and many lines run across a piece's border. The texts are non-ASCII on purpose.
    const lines = Array.from({ length: CONVERSATION_TURNS + 5 }, (_, i) => [ask(`Kérés ${String(i)}: árvíztűrő tükörfúrógép.`), ...fillerOf(300 * 1024)]).flat()
    const entries = await readTranscriptConversation(await transcriptOf(lines))
    expect(entries).toHaveLength(CONVERSATION_TURNS)
    expect(entries?.[0]).toMatchObject({ kind: 'prompt', text: 'Kérés 5: árvíztűrő tükörfúrógép.' })
    expect(entries?.at(-1)).toMatchObject({ kind: 'prompt', text: `Kérés ${String(CONVERSATION_TURNS + 4)}: árvíztűrő tükörfúrógép.` })
  })

  it('stops at the byte limit and drops the partial line there', async () => {
    const lines = [ask('Régi.'), ...fillerOf(64 * 1024), ask('Új.')]
    const entries = await readTranscriptConversation(await transcriptOf(lines), 32 * 1024)
    expect(entries).toEqual([{ kind: 'prompt', text: 'Új.', images: 0, truncated: false }])
  })

  it('skips a last line that is still being written', async () => {
    const file = path.join(await tempDir('cs-conversation-'), 'transcript.jsonl')
    await writeFile(file, `${ask('Kész sor.')}\n{"type":"assistant","message":{"content":[{"type":"te`, 'utf8')
    expect(await readTranscriptConversation(file)).toEqual([{ kind: 'prompt', text: 'Kész sor.', images: 0, truncated: false }])
  })

  it('returns an empty conversation for an empty file, and undefined for a missing one', async () => {
    expect(await readTranscriptConversation(await transcriptOf([]))).toEqual([])
    expect(await readTranscriptConversation(path.join(tmpdir(), 'cs-nope', 'missing.jsonl'))).toBeUndefined()
  })
})

describe('findTranscriptPath', () => {
  async function projectsFixture(): Promise<string> {
    const claudeDir = await tempDir('cs-tx-')
    await mkdir(path.join(claudeDir, 'projects', 'some-encoded-name'), { recursive: true })
    return claudeDir
  }

  it('finds the transcript whatever the project directory is called', async () => {
    const claudeDir = await projectsFixture()
    const file = path.join(claudeDir, 'projects', 'some-encoded-name', 'sid-1.jsonl')
    await writeFile(file, '')
    expect(await findTranscriptPath(claudeDir, 'sid-1')).toBe(file)
  })

  it('ignores a directory that happens to carry the transcript name', async () => {
    const claudeDir = await projectsFixture()
    await mkdir(path.join(claudeDir, 'projects', 'some-encoded-name', 'sid-1.jsonl'))
    expect(await findTranscriptPath(claudeDir, 'sid-1')).toBeUndefined()
  })

  it('returns undefined when no project directory holds it', async () => {
    const claudeDir = await projectsFixture()
    expect(await findTranscriptPath(claudeDir, 'sid-missing')).toBeUndefined()
  })

  it('returns undefined when there is no projects directory at all', async () => {
    const claudeDir = await tempDir('cs-tx-')
    expect(await findTranscriptPath(claudeDir, 'sid-1')).toBeUndefined()
  })
})

describe('tailLines', () => {
  async function fileWith(content: string): Promise<string> {
    const dir = await tempDir('cs-tail-')
    const file = path.join(dir, 'transcript.jsonl')
    await writeFile(file, content, 'utf8')
    return file
  }

  it('returns nothing for an empty file', async () => {
    expect(await tailLines(await fileWith(''))).toEqual([])
  })

  it('returns nothing for a file that does not exist', async () => {
    expect(await tailLines(path.join(tmpdir(), 'cs-nope', 'missing.jsonl'))).toEqual([])
  })

  it('returns every line when the file is smaller than the window', async () => {
    expect(await tailLines(await fileWith('a\nb\nc'))).toEqual(['a', 'b', 'c'])
  })

  it('drops the truncated first line instead of returning mangled text', async () => {
    // Transcripts hold non-ASCII text, so the seek may land in the middle of a multi-byte
    // character. The lines kept must be intact.
    const lines = ['árvíztűrő tükörfúrógép', 'öt szép szűzlány', 'hűtőházi rendszer']
    const file = await fileWith(lines.join('\n'))
    const tail = await tailLines(file, 40)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.every((line) => !line.includes('�'))).toBe(true)
    expect(tail[tail.length - 1]).toBe('hűtőházi rendszer')
  })

  it('returns nothing when file size is zero (early return before buffer allocation)', async () => {
    // On Windows `open()` works on a directory too, and its stat().size is zero. The early return
    // on `length === 0` handles it, not the catch block. This test proves the early return works.
    const dir = await tempDir('cs-tail-')
    expect(await tailLines(dir)).toEqual([])
  })

  it('catches and logs buffer allocation failure', async () => {
    // A synthetic trigger: maxBytes = -1 makes length < 0, and Buffer.alloc(negative) throws a
    // RangeError. It is the only way to reach the I/O catch block from a test on every platform.
    const file = await fileWith('content')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await tailLines(file, -1)).toEqual([])
      expect(errorSpy).toHaveBeenCalledOnce()
      expect(errorSpy.mock.calls[0]![0]).toMatch(/\[transcript\] tailLines failed/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
