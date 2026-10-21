import { describe, expect, it } from 'vitest'
import { TOOL_DETAIL_MAX, toolDetail } from './tool-detail.js'

describe('toolDetail', () => {
  it('uses the command of a shell tool', () => {
    expect(toolDetail({ command: 'pnpm test', description: 'Run tests' })).toBe('pnpm test')
  })

  it('flattens a multi-line command into one line', () => {
    expect(toolDetail({ command: 'cd x &&\n  pnpm   lint' })).toBe('cd x && pnpm lint')
  })

  it('uses the pattern of a search', () => {
    expect(toolDetail({ pattern: 'createPanel', path: 'src' })).toBe('createPanel')
  })

  it('shows only the file name of a path, with either separator', () => {
    expect(toolDetail({ file_path: 'P:\\proj\\src\\transcript.ts' })).toBe('transcript.ts')
    expect(toolDetail({ notebook_path: '/home/u/a/b.ipynb' })).toBe('b.ipynb')
  })

  it('falls back to url, query, description and skill, in that order', () => {
    expect(toolDetail({ url: 'https://example.test/a', prompt: 'x' })).toBe('https://example.test/a')
    expect(toolDetail({ query: 'vitest utimes' })).toBe('vitest utimes')
    expect(toolDetail({ description: 'Final-review fix wave', prompt: 'hosszú' })).toBe('Final-review fix wave')
    expect(toolDetail({ skill: 'graphify' })).toBe('graphify')
  })

  it('caps a long detail with an ellipsis', () => {
    const detail = toolDetail({ command: 'x'.repeat(500) })
    expect(detail).toHaveLength(TOOL_DETAIL_MAX)
    expect(detail?.endsWith('…')).toBe(true)
  })

  it('has nothing to say about unknown, empty or malformed input', () => {
    for (const input of [undefined, null, 42, 'str', [], {}, { command: '' }, { command: 7 }, { other: 'x' }, { command: '   ' }]) {
      expect(() => toolDetail(input)).not.toThrow()
      expect(toolDetail(input)).toBeUndefined()
    }
  })
})
