import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './testing.js'
import { findTranscriptPath, readActivityFromLines, tailLines } from './transcript.js'

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
