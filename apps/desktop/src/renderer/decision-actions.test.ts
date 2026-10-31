import { describe, expect, it } from 'vitest'
import {
  isActivationTarget,
  isSubmitChord,
  isTypingTarget,
  isUnreadableQuestion,
  readDecideResult,
  readOverlaySettings,
  shortcutFor,
  SUBMIT_CHORD_LABEL,
} from './decision-actions.js'

describe('shortcutFor', () => {
  it('maps the command keys, case-insensitively', () => {
    expect(['a', 'd', 'p', 'g', 'A'].map((key) => shortcutFor('tool', key, true))).toEqual([
      'allow',
      'deny',
      'rule-project',
      'rule-machine',
      'allow',
    ])
    expect(shortcutFor('tool', 'x', true)).toBeUndefined()
  })

  it('offers session edits for a file write, and no rules', () => {
    expect(shortcutFor('edit', 's', true)).toBe('session-edits')
    expect(shortcutFor('edit', 'p', true)).toBeUndefined()
    expect(shortcutFor('edit', 'g', true)).toBeUndefined()
  })

  it('has no key for a question — it can only be answered through the form', () => {
    for (const key of ['a', 'd', 'p', 'g', 's']) expect(shortcutFor('question', key, true)).toBeUndefined()
  })

  it('has no key for a plan — a stray key must not reject it, and approval happens in VS Code', () => {
    for (const key of ['a', 'd', 'p', 'g', 's']) expect(shortcutFor('plan', key, true)).toBeUndefined()
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

describe('isActivationTarget', () => {
  // A DOM-elem alakja, amit a függvény olvas: tagName, role (ARIA-tükrözés) és a szülő.
  function element(tagName: string, parentElement: unknown = null, role: string | null = null): unknown {
    return { tagName, role, parentElement }
  }

  it('is true for a button, a summary and a link, so Enter activates them', () => {
    expect(isActivationTarget(element('BUTTON'))).toBe(true)
    expect(isActivationTarget(element('SUMMARY'))).toBe(true)
    expect(isActivationTarget(element('A'))).toBe(true)
    expect(isActivationTarget(element('DIV', null, 'button'))).toBe(true)
  })

  it('is true inside one, e.g. the <kbd> in a button', () => {
    expect(isActivationTarget(element('KBD', element('BUTTON', element('DIV'))))).toBe(true)
    expect(isActivationTarget(element('SPAN', element('SPAN', element('SUMMARY'))))).toBe(true)
  })

  it('is false for the body and other elements, so Enter still jumps to VS Code there', () => {
    expect(isActivationTarget(element('BODY', element('HTML')))).toBe(false)
    expect(isActivationTarget(element('LI', element('UL', element('BODY'))))).toBe(false)
    expect(isActivationTarget(element('DIV', null, 'list'))).toBe(false)
    expect(isActivationTarget(null)).toBe(false)
    expect(isActivationTarget('BUTTON')).toBe(false)
  })
})

describe('isSubmitChord', () => {
  it('is Ctrl+Enter, the submit key of the multi-line fields', () => {
    expect(isSubmitChord({ key: 'Enter', ctrlKey: true })).toBe(true)
  })

  it('leaves a plain Enter to the textarea (a new line) and ignores other Ctrl keys', () => {
    expect(isSubmitChord({ key: 'Enter', ctrlKey: false })).toBe(false)
    expect(isSubmitChord({ key: 'a', ctrlKey: true })).toBe(false)
  })

  it('has a label that names the same chord', () => {
    expect(SUBMIT_CHORD_LABEL).toBe('Ctrl+Enter')
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

describe('isUnreadableQuestion', () => {
  it('flags a question whose list could not be read, so the panel offers jump and deny instead', () => {
    expect(isUnreadableQuestion({ kind: 'question', questions: [] })).toBe(true)
  })

  it('leaves a readable question and every other kind alone', () => {
    const question = { question: 'Mi a kedvenc színed?', multiSelect: false, options: [] }
    expect(isUnreadableQuestion({ kind: 'question', questions: [question] })).toBe(false)
    expect(isUnreadableQuestion({ kind: 'tool', questions: [] })).toBe(false)
    expect(isUnreadableQuestion({ kind: 'plan', questions: [] })).toBe(false)
  })
})

describe('shortcutFor — olvashatatlan kérés', () => {
  it('leaves only deny on the keyboard, since no allow can go out for it', () => {
    expect(['a', 'd', 'p', 'g'].map((key) => shortcutFor('tool', key, false))).toEqual([undefined, 'deny', undefined, undefined])
    expect(['a', 'd', 's'].map((key) => shortcutFor('edit', key, false))).toEqual([undefined, 'deny', undefined])
  })
})
