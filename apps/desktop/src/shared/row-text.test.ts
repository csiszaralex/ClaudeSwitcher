import { describe, expect, it } from 'vitest'
import { clip, pendingRowText } from './row-text.js'

describe('pendingRowText', () => {
  it('names the tool and the request in one clipped line, like the other row texts', () => {
    expect(pendingRowText({ toolName: 'Bash', summary: 'git add -A\n  git commit' })).toBe('Bash: git add -A git commit')
    const long = pendingRowText({ toolName: 'Bash', summary: `cat <<END\n${'x'.repeat(100_000)}\nEND` })
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('clip', () => {
  it('flattens line breaks and cuts to 80 characters', () => {
    expect(clip('a\nb')).toBe('a b')
    expect(clip('y'.repeat(200))).toHaveLength(80)
  })
})
