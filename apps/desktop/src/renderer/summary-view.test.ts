import { describe, expect, it } from 'vitest'
import { lineCount, revealInvisible, summaryView } from './summary-view.js'
import { DETAILS_LIMIT } from './tool-details.js'

describe('revealInvisible', () => {
  it('leaves ordinary text, line breaks and tabs alone', () => {
    expect(revealInvisible('git add -A\n\tgit commit')).toEqual([{ text: 'git add -A\n\tgit commit', hidden: false }])
    expect(revealInvisible('')).toEqual([])
  })

  it('turns a bidi override into a visible escape between the visible parts', () => {
    expect(revealInvisible('rm ‮txt.exe')).toEqual([
      { text: 'rm ', hidden: false },
      { text: '⟨U+202E⟩', hidden: true },
      { text: 'txt.exe', hidden: false },
    ])
  })

  it('reveals C0 and C1 controls, zero-width, bidi and tag characters, one escape each', () => {
    const invisible = [
      '\u0000', '\u0007', '\r', '\u001B', '\u007F', '\u0085', '\u009F', '­',
      '؜', '᠎', '​', '‌', '‍', '‎', '‏',
      ' ', ' ', '‪', '‮', '⁠', '⁤', '⁦', '⁩', '﻿',
      '\u{E0041}', '\u{E0100}',
    ]
    for (const char of invisible) {
      const code = char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? ''
      expect(revealInvisible(`a${char}b`), code).toEqual([
        { text: 'a', hidden: false },
        { text: `⟨U+${code}⟩`, hidden: true },
        { text: 'b', hidden: false },
      ])
    }
  })

  it('keeps visible non-ASCII text, emoji included', () => {
    expect(revealInvisible('echo árvíztűrő 👍')).toEqual([{ text: 'echo árvíztűrő 👍', hidden: false }])
  })
})

describe('lineCount', () => {
  it('counts the lines of the command', () => {
    expect(lineCount('ls')).toBe(1)
    expect(lineCount('a\nb\nc')).toBe(3)
  })
})

describe('summaryView', () => {
  it('shows a short summary whole, with its line count', () => {
    expect(summaryView('a\nb')).toEqual({ segments: [{ text: 'a\nb', hidden: false }], lines: 2, truncated: false })
  })

  it('caps the rendered text at DETAILS_LIMIT but counts the lines of the whole command', () => {
    const huge = `${'x'.repeat(DETAILS_LIMIT)}\nsecret tail`
    const view = summaryView(huge)
    expect(view.truncated).toBe(true)
    expect(view.lines).toBe(2)
    expect(view.segments.map((segment) => segment.text).join('')).toBe('x'.repeat(DETAILS_LIMIT))
  })

  it('takes a smaller limit for tests', () => {
    expect(summaryView('abcdef', 3)).toEqual({ segments: [{ text: 'abc', hidden: false }], lines: 1, truncated: true })
  })
})
