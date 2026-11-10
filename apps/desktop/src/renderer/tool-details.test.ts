import { describe, expect, it } from 'vitest'
import { DETAILS_LIMIT, formatToolInput, sandboxDisabled, showsDetails, toolDetails } from './tool-details.js'

describe('showsDetails', () => {
  it('offers details for a tool request with input', () => {
    expect(showsDetails({ kind: 'tool', toolName: 'Workflow', toolInput: { script: 'x' } })).toBe(true)
    expect(showsDetails({ kind: 'tool', toolName: 'mcp__github__create_issue', toolInput: { title: 't' } })).toBe(true)
  })

  it('offers none for a shell command: the command already is the content', () => {
    expect(showsDetails({ kind: 'tool', toolName: 'Bash', toolInput: { command: 'ls', description: 'd' } })).toBe(false)
    expect(showsDetails({ kind: 'tool', toolName: 'PowerShell', toolInput: { command: 'ls' } })).toBe(false)
  })

  it('offers none for the other kinds: they have their own view', () => {
    for (const kind of ['edit', 'question', 'plan'] as const) {
      expect(showsDetails({ kind, toolName: 'X', toolInput: { a: 1 } })).toBe(false)
    }
  })

  it('offers none for an empty or malformed input', () => {
    expect(showsDetails({ kind: 'tool', toolName: 'X', toolInput: {} })).toBe(false)
    // At runtime the daemon's message can be anything; sanitizeState does not check toolInput.
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

describe('toolDetails: a tool that runs a command', () => {
  it('shows every field of a shell request except the command and its description', () => {
    const decision = {
      kind: 'tool' as const,
      toolName: 'Bash',
      toolInput: { command: 'ls', description: 'd', run_in_background: true, timeout: 5000 },
    }
    expect(showsDetails(decision)).toBe(true)
    expect(toolDetails(decision)).toEqual({
      blocks: [{ text: JSON.stringify({ run_in_background: true, timeout: 5000 }, null, 2) }],
      truncated: false,
    })
  })

  it('has no details for a shell request with only a command and a description', () => {
    expect(toolDetails({ kind: 'tool', toolName: 'PowerShell', toolInput: { command: 'ls', description: 'd' } })).toBeUndefined()
  })

  it('keeps every field for any other tool', () => {
    expect(toolDetails({ kind: 'tool', toolName: 'mcp__x__y', toolInput: { command: 'c', description: 'd' } })?.blocks).toEqual([
      { text: JSON.stringify({ command: 'c', description: 'd' }, null, 2) },
    ])
  })
})

describe('sandboxDisabled', () => {
  it('is true only for an explicit dangerouslyDisableSandbox: true', () => {
    expect(sandboxDisabled({ command: 'ls', dangerouslyDisableSandbox: true })).toBe(true)
    expect(sandboxDisabled({ command: 'ls', dangerouslyDisableSandbox: false })).toBe(false)
    expect(sandboxDisabled({ command: 'ls', dangerouslyDisableSandbox: 'true' })).toBe(false)
    expect(sandboxDisabled({ command: 'ls' })).toBe(false)
    expect(sandboxDisabled(null)).toBe(false)
  })
})
