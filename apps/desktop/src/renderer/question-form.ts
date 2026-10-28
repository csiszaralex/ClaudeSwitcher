import type { AskQuestion } from '@claudeswitcher/core'
import { joinAnswerLabels } from '@claudeswitcher/core/browser'

interface QuestionState {
  selected: string[]
  other: string
}

/** Kérdésenként a választás — kulcs a kérdés szövege, mint a hook válaszában. */
export type FormState = Record<string, QuestionState>

const EMPTY: QuestionState = { selected: [], other: '' }

export function initialFormState(questions: readonly AskQuestion[]): FormState {
  return Object.fromEntries(questions.map((question) => [question.question, EMPTY]))
}

function stateOf(state: FormState, question: AskQuestion): QuestionState {
  return state[question.question] ?? EMPTY
}

/** Egyválasztósnál a választás lecseréli az előzőt és törli a szabad szöveget; többválasztósnál ki-be kapcsol. */
export function toggleOption(state: FormState, question: AskQuestion, label: string): FormState {
  const current = stateOf(state, question)
  if (!question.multiSelect) return { ...state, [question.question]: { selected: [label], other: '' } }
  const selected = current.selected.includes(label)
    ? current.selected.filter((chosen) => chosen !== label)
    : [...current.selected, label]
  return { ...state, [question.question]: { selected, other: current.other } }
}

/** Egyválasztósnál a szabad szöveg kizárja a választott opciót — a natív „Other" is így viselkedik. */
export function setOtherText(state: FormState, question: AskQuestion, text: string): FormState {
  const current = stateOf(state, question)
  const selected = question.multiSelect || text.trim() === '' ? current.selected : []
  return { ...state, [question.question]: { selected, other: text } }
}

/**
 * A válaszok a hook formátumában (mérve, spike K1 és R1): kulcs a kérdés szövege, érték az opció
 * label-je; több opció a kérdés sorrendjében `", "`-vel; a szabad szöveg szó szerint.
 */
export function buildAnswers(questions: readonly AskQuestion[], state: FormState): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const { selected, other } = stateOf(state, question)
    const ordered = question.options.map((option) => option.label).filter((label) => selected.includes(label))
    const extra = other.trim()
    if (question.multiSelect) {
      answers[question.question] = joinAnswerLabels(extra === '' ? ordered : [...ordered, extra])
    } else {
      answers[question.question] = extra !== '' ? extra : (ordered[0] ?? '')
    }
  }
  return answers
}

/**
 * Igaz, ha minden kérdésre van nem üres válasz — csak ekkor küldhető el. Üres listánál soha: az
 * azt jelenti, hogy a kérdéseket nem tudtuk kiolvasni, és egy „üres" válasz nem válasz.
 */
export function isComplete(questions: readonly AskQuestion[], state: FormState): boolean {
  if (questions.length === 0) return false
  const answers = buildAnswers(questions, state)
  return questions.every((question) => (answers[question.question] ?? '').trim() !== '')
}
