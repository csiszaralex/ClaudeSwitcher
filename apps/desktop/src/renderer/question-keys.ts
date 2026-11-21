import type { AskQuestion } from '@claudeswitcher/core'
import { isSubmitChord } from './decision-actions.js'
import { isAnswered, type FormState } from './question-form.js'

/**
 * Which question and which of its options the question form has in focus, and what each key does
 * there. The form shows one question at a time (`QuestionForm`); its cursor is an index into the
 * active question's options, where `options.length` is the free text field ("Egyéb").
 */

/** The cursor index of the question's free text field: one past its last option. */
export function otherCursor(question: AskQuestion): number {
  return question.options.length
}

/** Where a question's cursor starts when it is opened: on its first chosen option, else on the first one. */
export function initialCursor(question: AskQuestion, state: FormState): number {
  const selected = state[question.question]?.selected ?? []
  const index = question.options.findIndex((option) => selected.includes(option.label))
  return index === -1 ? 0 : index
}

/** The previous or next question; it stops at the first and the last one. */
export function stepQuestion(active: number, step: -1 | 1, count: number): number {
  return Math.min(Math.max(active + step, 0), Math.max(count - 1, 0))
}

/**
 * The question to move on to after `active` was answered: the first unanswered one after it,
 * wrapping around to the start. `active` itself when every other question is answered, so the
 * moving on never leaves the question by itself for nowhere.
 */
export function nextUnanswered(questions: readonly AskQuestion[], state: FormState, active: number): number {
  for (let offset = 1; offset < questions.length; offset += 1) {
    const index = (active + offset) % questions.length
    const question = questions[index]
    if (question !== undefined && !isAnswered(question, state)) return index
  }
  return active
}

/** What a key does in the question form. */
export type QuestionCommand =
  /** The cursor goes to this index of the active question (`otherCursor`: the free text field). */
  | { type: 'cursor'; to: number }
  /** The previous or the next question opens. */
  | { type: 'question'; step: -1 | 1 }
  /**
   * The option is picked (single choice) or toggled (multiple choice); with `moveOn` the next
   * unanswered question opens. With `finish` (Enter) the answers are sent instead when none is left
   * unanswered (`QuestionForm`; asked by the owner, 2026-11-22: Enter on the last one sends).
   */
  | { type: 'select'; option: number; moveOn: boolean; finish?: true }
  /** The next unanswered question opens; with `finish` (Enter), the answers are sent when none is left. */
  | { type: 'move-on'; finish?: true }
  /** The answers are sent, if complete. */
  | { type: 'submit' }
  /** The focus leaves the form, back to the list. */
  | { type: 'leave' }
  /** Nothing happens, but the key's default is prevented too: a held key's auto-repeat. */
  | { type: 'ignore' }

/**
 * Where the key was pressed: on the options (the form's option box), in the free text field, or on
 * another element of the form (its submit button).
 */
export type QuestionPlace = 'options' | 'other' | 'elsewhere'

/** A keydown event as the question form sees it. */
export interface QuestionKey {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  /** The browser's auto-repeat (a held key). */
  repeat: boolean
}

/** The option a digit key picks (1 to 9, as in Claude Code's terminal prompt), or `undefined`. */
function digitOption(key: string, question: AskQuestion): number | undefined {
  if (!/^[1-9]$/.test(key)) return undefined
  const option = Number(key) - 1
  return option < question.options.length ? option : undefined
}

/**
 * The command of a key in the question form, or `undefined` when the key is left to the focused
 * element (typing in the free text field, Tab's focus move, a modifier chord, Space or Enter on
 * the submit button).
 *
 * - Ctrl+Enter sends (`isSubmitChord`, the one rule of the multi-line fields), Esc leaves the form.
 * - ↑/↓ step through the options and the free text field; ↑ in the field goes back to the last option.
 * - ←/→ open the previous or next question, except in the field, where they move the caret.
 * - Space or Enter picks the option under the cursor; for single choice that moves on. For multiple
 *   choice Space toggles and Enter moves on. Enter in the field moves on. An Enter carries `finish`:
 *   when it leaves no question unanswered, the form sends instead of moving on (`QuestionForm`).
 * - 1 to 9 pick that option directly, as Space would (not in the field, where they are text).
 *
 * A held key's auto-repeat picks nothing and moves on nowhere (`ignore`): one long press must not
 * answer several questions. The arrows do repeat: they only move the cursor or the question.
 */
export function questionKeyCommand(
  event: QuestionKey,
  place: QuestionPlace,
  question: AskQuestion,
  cursor: number,
): QuestionCommand | undefined {
  const acting = (command: QuestionCommand): QuestionCommand => (event.repeat ? { type: 'ignore' } : command)
  if (isSubmitChord(event)) return acting({ type: 'submit' })
  if (event.key === 'Escape') return { type: 'leave' }
  if (event.ctrlKey || event.altKey || event.metaKey) return undefined

  if (place === 'other') {
    if (event.key === 'ArrowUp') return question.options.length > 0 ? { type: 'cursor', to: question.options.length - 1 } : undefined
    if (event.key === 'Enter') return acting({ type: 'move-on', finish: true })
    return undefined
  }

  switch (event.key) {
    case 'ArrowUp':
      return { type: 'cursor', to: Math.max(cursor - 1, 0) }
    case 'ArrowDown':
      return { type: 'cursor', to: Math.min(cursor + 1, otherCursor(question)) }
    case 'ArrowLeft':
      return { type: 'question', step: -1 }
    case 'ArrowRight':
      return { type: 'question', step: 1 }
  }
  // Space and Enter press the submit button when it has the focus.
  if (place === 'options' && cursor < otherCursor(question)) {
    if (event.key === ' ') return acting({ type: 'select', option: cursor, moveOn: !question.multiSelect })
    if (event.key === 'Enter') {
      return acting(
        question.multiSelect ? { type: 'move-on', finish: true } : { type: 'select', option: cursor, moveOn: true, finish: true },
      )
    }
  }
  const digit = digitOption(event.key, question)
  if (digit !== undefined) return acting({ type: 'select', option: digit, moveOn: !question.multiSelect })
  return undefined
}
