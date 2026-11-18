import type { DecisionKind } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
import { lineCount, revealInvisible, showsSummary, summaryView } from './summary-view.js'
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

describe('showsSummary', () => {
  const questions = [{ question: 'Which one?' }]
  const request = (kind: DecisionKind, released: boolean, list: readonly unknown[] = []) => ({
    kind,
    released,
    questions: list,
  })

  it('hides it while the question form or the plan panel shows the content itself', () => {
    expect(showsSummary(request('question', false, questions))).toBe(false)
    expect(showsSummary(request('plan', false))).toBe(false)
  })

  it('shows it for a released question and a released plan: only the jump row stands below them', () => {
    expect(showsSummary(request('question', true, questions))).toBe(true)
    expect(showsSummary(request('plan', true))).toBe(true)
  })

  it('hides it for an unreadable question, whose summary is the tool name the header shows', () => {
    expect(showsSummary(request('question', false))).toBe(false)
    expect(showsSummary(request('question', true))).toBe(false)
  })

  it('shows it for a command and a file edit, released or not', () => {
    for (const released of [false, true]) {
      expect(showsSummary(request('tool', released))).toBe(true)
      expect(showsSummary(request('edit', released))).toBe(true)
    }
  })
})
