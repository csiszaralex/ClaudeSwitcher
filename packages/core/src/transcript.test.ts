import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    // Valid JSON, és a `.type` olvasása rajta TypeError-t dobna. Ez a fajta
    // meglepetés az, amiért ez a modul egyáltalán toleráns.
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
    // Konstruált sorok a mért subagent-alakban: agentId, isSidechain, és api-request zaj.
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

describe('findTranscriptPath', () => {
  async function projectsFixture(): Promise<string> {
    const claudeDir = await mkdtemp(path.join(tmpdir(), 'cs-tx-'))
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
    const claudeDir = await mkdtemp(path.join(tmpdir(), 'cs-tx-'))
    expect(await findTranscriptPath(claudeDir, 'sid-1')).toBeUndefined()
  })
})

describe('tailLines', () => {
  async function fileWith(content: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-tail-'))
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
    // A transcriptek nem ASCII szöveget tartalmaznak, tehát a seek egy több
    // bájtos karakter közepére eshet. A megtartott soroknak épnek kell lenniük.
    const lines = ['árvíztűrő tükörfúrógép', 'öt szép szűzlány', 'hűtőházi rendszer']
    const file = await fileWith(lines.join('\n'))
    const tail = await tailLines(file, 40)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.every((line) => !line.includes('�'))).toBe(true)
    expect(tail[tail.length - 1]).toBe('hűtőházi rendszer')
  })

  it('returns nothing when file size is zero (early return before buffer allocation)', async () => {
    // A Windows-on `open()` egy könyvtárra is működik, és az stat().size nulla.
    // Az `if (length === 0)` korai visszatérés ezt kezeli, nem a catch blokk.
    // Ez a test azt bizonyítja, hogy a korai return működik.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-tail-'))
    expect(await tailLines(dir)).toEqual([])
  })

  it('catches and logs buffer allocation failure', async () => {
    // Szintetikus kiváltó: a maxBytes = -1 miatt length < 0 lesz, és
    // Buffer.alloc(negative) RangeError-t dob. Ez az egyetlen módja annak, hogy
    // az I/O catch blokkot minden platformon ki tudjuk váltani a tesztből.
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
