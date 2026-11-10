import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_SCAN_LIMIT,
  SUBAGENT_STALE_MS,
  parseSubagentMeta,
  pickRecentSubagentFiles,
  subagentIdFromFile,
  subagentMetaFile,
} from './subagent.js'

// Constructed meta files in the measured shape (Claude Code 2.1.30x, 2026-10-21), not real content.
const runningMeta = {
  agentType: 'general-purpose',
  description: 'Teszt hullám',
  toolUseId: 'toolu_constructed_1',
  spawnDepth: 1,
  requestShape: 'background',
  requestNonInteractive: true,
  model: 'sonnet',
}

describe('parseSubagentMeta', () => {
  it('reads the fields of a running subagent', () => {
    expect(parseSubagentMeta(runningMeta)).toEqual({
      agentType: 'general-purpose',
      description: 'Teszt hullám',
      toolUseId: 'toolu_constructed_1',
      finished: false,
    })
  })

  it('reports finished only for a literal true', () => {
    expect(parseSubagentMeta({ ...runningMeta, finished: true }).finished).toBe(true)
    expect(parseSubagentMeta({ ...runningMeta, finished: 'true' }).finished).toBe(false)
    expect(parseSubagentMeta({ ...runningMeta, finished: 1 }).finished).toBe(false)
  })

  it('flattens a multi-line description', () => {
    expect(parseSubagentMeta({ description: '  két\n  sor ' }).description).toBe('két sor')
  })

  it('treats missing or wrongly typed fields as no information, never throwing', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}, { agentType: 5, description: null, toolUseId: {} }]) {
      expect(() => parseSubagentMeta(raw)).not.toThrow()
      expect(parseSubagentMeta(raw)).toEqual({ finished: false })
    }
  })
})

describe('subagentMetaFile', () => {
  it('names the meta file next to the transcript of the same subagent', () => {
    expect(subagentMetaFile('a0123456789abcdef')).toBe('agent-a0123456789abcdef.meta.json')
  })
})

describe('subagentIdFromFile', () => {
  it('takes the agent id from a transcript file name', () => {
    expect(subagentIdFromFile('agent-a13ed7046d58dcc2d.jsonl')).toBe('a13ed7046d58dcc2d')
  })

  it('ignores the meta file and anything else', () => {
    for (const name of ['agent-a1.meta.json', 'agent-.jsonl', 'other.jsonl', 'agent-a1.jsonl.tmp', 'tool-results']) {
      expect(subagentIdFromFile(name)).toBeUndefined()
    }
  })
})

describe('pickRecentSubagentFiles', () => {
  const now = 10_000_000

  it('keeps only files written within the staleness window, newest first', () => {
    const files = [
      { agentId: 'old', mtimeMs: now - SUBAGENT_STALE_MS - 1 },
      { agentId: 'mid', mtimeMs: now - 60_000 },
      { agentId: 'new', mtimeMs: now - 1_000 },
      { agentId: 'edge', mtimeMs: now - SUBAGENT_STALE_MS },
    ]
    expect(pickRecentSubagentFiles(files, now).map((f) => f.agentId)).toEqual(['new', 'mid', 'edge'])
  })

  it('looks at no more than the scan limit', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ agentId: `a${String(i)}`, mtimeMs: now - i * 1_000 }))
    const picked = pickRecentSubagentFiles(files, now)
    expect(picked).toHaveLength(SUBAGENT_SCAN_LIMIT)
    expect(picked.map((f) => f.agentId)).toEqual(['a0', 'a1', 'a2'])
  })

  it('keeps a file whose clock is slightly ahead of ours', () => {
    expect(pickRecentSubagentFiles([{ agentId: 'x', mtimeMs: now + 500 }], now)).toHaveLength(1)
  })

  it('carries extra fields through untouched', () => {
    const picked = pickRecentSubagentFiles([{ agentId: 'x', mtimeMs: now, path: '/p/x' }], now)
    expect(picked[0]?.path).toBe('/p/x')
  })
})
