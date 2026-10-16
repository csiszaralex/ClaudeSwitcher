import { describe, expect, it } from 'vitest'
import { DETAILS_LIMIT, formatToolInput, showsDetails } from './tool-details.js'

describe('showsDetails', () => {
  it('offers details for a tool request with input', () => {
    expect(showsDetails({ kind: 'tool', toolName: 'Workflow', toolInput: { script: 'x' } })).toBe(true)
    expect(showsDetails({ kind: 'tool', toolName: 'mcp__github__create_issue', toolInput: { title: 't' } })).toBe(true)
  })

  it('offers none for a shell command — the command already is the content', () => {
    expect(showsDetails({ kind: 'tool', toolName: 'Bash', toolInput: { command: 'ls', description: 'd' } })).toBe(false)
    expect(showsDetails({ kind: 'tool', toolName: 'PowerShell', toolInput: { command: 'ls' } })).toBe(false)
  })

  it('offers none for the other kinds — they have their own view', () => {
    for (const kind of ['edit', 'question', 'plan'] as const) {
      expect(showsDetails({ kind, toolName: 'X', toolInput: { a: 1 } })).toBe(false)
    }
  })

  it('offers none for an empty or malformed input', () => {
    expect(showsDetails({ kind: 'tool', toolName: 'X', toolInput: {} })).toBe(false)
    // A daemon üzenete futásidőben bármi lehet; a sanitizeState a toolInput-ot nem ellenőrzi.
    expect(showsDetails({ kind: 'tool', toolName: 'X', toolInput: null })).toBe(false)
  })
})

describe('formatToolInput', () => {
  it('pretty-prints the input as JSON', () => {
    expect(formatToolInput({ url: 'https://x', depth: 2 })).toEqual({
      blocks: [{ text: '{\n  "url": "https://x",\n  "depth": 2\n}' }],
      truncated: false,
    })
  })

  it('shows a multi-line string as its own text block, not as one escaped JSON line', () => {
    const script = 'export const meta = {\n  name: "x",\n}\nawait run()'
    expect(formatToolInput({ script, args: { a: 1 } })).toEqual({
      blocks: [{ text: '{\n  "args": {\n    "a": 1\n  }\n}' }, { label: 'script', text: script }],
      truncated: false,
    })
  })

  it('shows a long single-line string as its own block too', () => {
    const prompt = 'p'.repeat(200)
    expect(formatToolInput({ prompt }).blocks).toEqual([{ label: 'prompt', text: prompt }])
  })

  it('caps the rendered size so a huge script cannot freeze the overlay', () => {
    const script = 'line\n'.repeat(DETAILS_LIMIT)
    const result = formatToolInput({ script, other: 'y'.repeat(DETAILS_LIMIT) })
    expect(result.truncated).toBe(true)
    const total = result.blocks.reduce((sum, block) => sum + block.text.length, 0)
    expect(total).toBeLessThanOrEqual(DETAILS_LIMIT)
  })

  it('honours a custom limit', () => {
    const result = formatToolInput({ script: 'a\nb\nc\nd' }, 3)
    expect(result).toEqual({ blocks: [{ label: 'script', text: 'a\nb' }], truncated: true })
  })

  it('returns nothing for a non-object', () => {
    expect(formatToolInput(null)).toEqual({ blocks: [], truncated: false })
    expect(formatToolInput('x')).toEqual({ blocks: [], truncated: false })
  })
})
