import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ideDir, resolveClaudeDir, sessionsDir, userSettingsPath } from './paths.js'

describe('resolveClaudeDir', () => {
  it('prefers CLAUDE_CONFIG_DIR when it is set', () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: 'd:\\custom' })).toBe('d:\\custom')
  })

  it('trims incidental whitespace around the override', () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '  d:\\custom  ' })).toBe('d:\\custom')
  })

  it('falls back to the home directory when the override is absent or blank', () => {
    const fallback = path.join(os.homedir(), '.claude')
    expect(resolveClaudeDir({})).toBe(fallback)
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '   ' })).toBe(fallback)
  })
})

describe('directory helpers', () => {
  it('derive their paths from the given claude dir', () => {
    expect(sessionsDir('d:\\c')).toBe(path.join('d:\\c', 'sessions'))
    expect(ideDir('d:\\c')).toBe(path.join('d:\\c', 'ide'))
    expect(userSettingsPath('d:\\c')).toBe(path.join('d:\\c', 'settings.json'))
  })
})
