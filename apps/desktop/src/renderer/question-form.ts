import type { AskQuestion } from '@claudeswitcher/core'
import { joinAnswerLabels } from '@claudeswitcher/core/browser'

interface QuestionState {
  selected: string[]
  other: string
}

/** The choice per question: the key is the question text, as in the hook reply. */
export type FormState = Record<string, QuestionState>

const EMPTY: QuestionState = { selected: [], other: '' }

export function initialFormState(questions: readonly AskQuestion[]): FormState {
  return Object.fromEntries(questions.map((question) => [question.question, EMPTY]))
}

function stateOf(state: FormState, question: AskQuestion): QuestionState {
  return state[question.question] ?? EMPTY
}

/** For single choice the pick replaces the previous one and clears the free text; for multiple choice it toggles. */
export function toggleOption(state: FormState, question: AskQuestion, label: string): FormState {
  const current = stateOf(state, question)
  if (!question.multiSelect) return { ...state, [question.question]: { selected: [label], other: '' } }
  const selected = current.selected.includes(label)
    ? current.selected.filter((chosen) => chosen !== label)
    : [...current.selected, label]
  return { ...state, [question.question]: { selected, other: current.other } }
}

/** For single choice the free text excludes the picked option; the native "Other" behaves the same. */
export function setOtherText(state: FormState, question: AskQuestion, text: string): FormState {
  const current = stateOf(state, question)
  const selected = question.multiSelect || text.trim() === '' ? current.selected : []
  return { ...state, [question.question]: { selected, other: text } }
}

/**
 * One question's answer in the hook's format (measured, cases K1 and R1 in
 * spikes/m2-permission/RESULTS.md): the option's label; several options in the question's order
 * joined with `", "`; the free text verbatim.
 */
function answerOf(question: AskQuestion, state: FormState): string {
  const { selected, other } = stateOf(state, question)
  const ordered = question.options.map((option) => option.label).filter((label) => selected.includes(label))
  const extra = other.trim()
  if (question.multiSelect) return joinAnswerLabels(extra === '' ? ordered : [...ordered, extra])
  return extra !== '' ? extra : (ordered[0] ?? '')
}

/** The answers in the hook's format: the key is the question text, the value `answerOf`. */
export function buildAnswers(questions: readonly AskQuestion[], state: FormState): Record<string, string> {
  return Object.fromEntries(questions.map((question) => [question.question, answerOf(question, state)]))
}

/** True if the question has a non-empty answer (its tab shows ✓). */
export function isAnswered(question: AskQuestion, state: FormState): boolean {
  return answerOf(question, state).trim() !== ''
}

/**
 * True if every question has a non-empty answer: only then can it be sent. Never for an empty list:
 * that means the questions could not be read, and an "empty" answer is no answer.
 */
export function isComplete(questions: readonly AskQuestion[], state: FormState): boolean {
  return questions.length > 0 && questions.every((question) => isAnswered(question, state))
}

/** The label of a question's tab: its `header`, else its number ("2. kérdés"). */
export function questionTabLabel(question: AskQuestion, index: number): string {
  const header = question.header?.trim() ?? ''
  return header !== '' ? header : `${String(index + 1)}. kérdés`
}
