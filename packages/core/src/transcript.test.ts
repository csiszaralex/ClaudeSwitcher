import { describe, expect, it } from 'vitest'
import { readActivityFromLines } from './transcript.js'

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
})
