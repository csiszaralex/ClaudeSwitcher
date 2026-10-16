import { describe, expect, it } from 'vitest'
import { isTypingTarget, readDecideResult, readOverlaySettings, shortcutFor } from './decision-actions.js'

describe('shortcutFor', () => {
  it('maps the command keys, case-insensitively', () => {
    expect(['a', 'd', 'p', 'g', 'A'].map((key) => shortcutFor('tool', key))).toEqual([
      'allow',
      'deny',
      'rule-project',
      'rule-machine',
      'allow',
    ])
    expect(shortcutFor('tool', 'x')).toBeUndefined()
  })

  it('offers session edits for a file write, and no rules', () => {
    expect(shortcutFor('edit', 's')).toBe('session-edits')
    expect(shortcutFor('edit', 'p')).toBeUndefined()
    expect(shortcutFor('edit', 'g')).toBeUndefined()
  })

  it('has no key for a question — it can only be answered through the form', () => {
    for (const key of ['a', 'd', 'p', 'g', 's']) expect(shortcutFor('question', key)).toBeUndefined()
  })

  it('has no key for a plan — a stray key must not reject it, and approval happens in VS Code', () => {
    for (const key of ['a', 'd', 'p', 'g', 's']) expect(shortcutFor('plan', key)).toBeUndefined()
  })
})

describe('isTypingTarget', () => {
  it('is true for text fields, so keys there belong to the field', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('is false for everything else', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget('INPUT')).toBe(false)
  })
})

describe('readDecideResult', () => {
  it('reads the main process\'s answer, and turns anything else into a readable failure', () => {
    expect(readDecideResult({ ok: true })).toEqual({ ok: true })
    expect(readDecideResult({ ok: false, reason: 'lezárult' })).toEqual({ ok: false, reason: 'lezárult' })
    expect(readDecideResult(undefined).ok).toBe(false)
    expect(readDecideResult({ ok: false }).ok).toBe(false)
  })
})

describe('readOverlaySettings', () => {
  it('reads the auto-hide setting from main', () => {
    expect(readOverlaySettings({ hideAfterLastDecision: false })).toEqual({ hideAfterLastDecision: false })
    expect(readOverlaySettings({ hideAfterLastDecision: true })).toEqual({ hideAfterLastDecision: true })
  })

  it('falls back to the default (hide) for anything else — the IPC can carry anything', () => {
    for (const raw of [undefined, null, 'x', {}, { hideAfterLastDecision: 'false' }]) {
      expect(readOverlaySettings(raw)).toEqual({ hideAfterLastDecision: true })
    }
  })
})
