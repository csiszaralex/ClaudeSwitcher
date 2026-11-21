import type { AskQuestion } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
import { initialFormState, setOtherText, toggleOption } from './question-form.js'
import {
  initialCursor,
  nextUnanswered,
  otherCursor,
  questionKeyCommand,
  stepQuestion,
  type QuestionKey,
} from './question-keys.js'

const single: AskQuestion = {
  question: 'Melyik ágon dolgozzunk?',
  header: 'Ág',
  multiSelect: false,
  options: [{ label: 'main' }, { label: 'fejlesztés' }, { label: 'kísérlet' }],
}
const multi: AskQuestion = {
  question: 'Mely teszteket futtassuk?',
  header: 'Tesztek',
  multiSelect: true,
  options: [{ label: 'egység' }, { label: 'komponens' }],
}
const third: AskQuestion = { question: 'Mi legyen a neve?', multiSelect: false, options: [{ label: 'alfa' }] }
const questions = [single, multi, third]

function key(name: string, overrides: Partial<QuestionKey> = {}): QuestionKey {
  return { key: name, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...overrides }
}

describe('the cursor and the question order', () => {
  it('puts the free text field one past the last option', () => {
    expect(otherCursor(single)).toBe(3)
  })

  it('starts the cursor on the first chosen option, else on the first one', () => {
    let state = initialFormState(questions)
    expect(initialCursor(multi, state)).toBe(0)
    state = toggleOption(state, multi, 'komponens')
    expect(initialCursor(multi, state)).toBe(1)
  })

  it('steps to the previous or next question and stops at the ends', () => {
    expect(stepQuestion(0, -1, 3)).toBe(0)
    expect(stepQuestion(0, 1, 3)).toBe(1)
    expect(stepQuestion(2, 1, 3)).toBe(2)
    expect(stepQuestion(0, 1, 1)).toBe(0)
  })

  it('moves on to the first unanswered question after the active one, wrapping around', () => {
    let state = initialFormState(questions)
    expect(nextUnanswered(questions, state, 0)).toBe(1)
    state = toggleOption(state, multi, 'egység')
    expect(nextUnanswered(questions, state, 0)).toBe(2)
    state = setOtherText(state, third, 'béta')
    // Only the first is unanswered: from the last one it wraps around to it.
    expect(nextUnanswered(questions, state, 2)).toBe(0)
  })

  it('stays on the active question when every other one is answered', () => {
    let state = initialFormState(questions)
    state = toggleOption(state, multi, 'egység')
    state = toggleOption(state, third, 'alfa')
    expect(nextUnanswered(questions, state, 0)).toBe(0)
  })
})

describe('the keys on the options', () => {
  it('steps the cursor with the arrows, down onto the free text field and no further', () => {
    expect(questionKeyCommand(key('ArrowDown'), 'options', single, 0)).toEqual({ type: 'cursor', to: 1 })
    expect(questionKeyCommand(key('ArrowDown'), 'options', single, 2)).toEqual({ type: 'cursor', to: 3 })
    expect(questionKeyCommand(key('ArrowDown'), 'options', single, 3)).toEqual({ type: 'cursor', to: 3 })
    expect(questionKeyCommand(key('ArrowUp'), 'options', single, 0)).toEqual({ type: 'cursor', to: 0 })
  })

  it('opens the previous or next question with the side arrows', () => {
    expect(questionKeyCommand(key('ArrowLeft'), 'options', single, 0)).toEqual({ type: 'question', step: -1 })
    expect(questionKeyCommand(key('ArrowRight'), 'options', single, 0)).toEqual({ type: 'question', step: 1 })
  })

  it('picks and moves on with Space or Enter for single choice; Enter may also finish', () => {
    expect(questionKeyCommand(key(' '), 'options', single, 1)).toEqual({ type: 'select', option: 1, moveOn: true })
    expect(questionKeyCommand(key('Enter'), 'options', single, 1)).toEqual({ type: 'select', option: 1, moveOn: true, finish: true })
  })

  it('toggles on Space and moves on on Enter for multiple choice', () => {
    expect(questionKeyCommand(key(' '), 'options', multi, 1)).toEqual({ type: 'select', option: 1, moveOn: false })
    expect(questionKeyCommand(key('Enter'), 'options', multi, 1)).toEqual({ type: 'move-on', finish: true })
  })

  it('picks the option of a digit directly, and ignores a digit past the last option', () => {
    expect(questionKeyCommand(key('3'), 'options', single, 0)).toEqual({ type: 'select', option: 2, moveOn: true })
    expect(questionKeyCommand(key('2'), 'options', multi, 0)).toEqual({ type: 'select', option: 1, moveOn: false })
    expect(questionKeyCommand(key('4'), 'options', single, 0)).toBeUndefined()
    expect(questionKeyCommand(key('0'), 'options', single, 0)).toBeUndefined()
  })

  it('sends on Ctrl+Enter and leaves on Esc', () => {
    expect(questionKeyCommand(key('Enter', { ctrlKey: true }), 'options', single, 0)).toEqual({ type: 'submit' })
    expect(questionKeyCommand(key('Escape'), 'options', single, 0)).toEqual({ type: 'leave' })
  })

  it('leaves Tab and modifier chords to the browser', () => {
    expect(questionKeyCommand(key('Tab'), 'options', single, 0)).toBeUndefined()
    expect(questionKeyCommand(key('1', { altKey: true, ctrlKey: true }), 'options', single, 0)).toBeUndefined()
    expect(questionKeyCommand(key(' ', { metaKey: true }), 'options', single, 0)).toBeUndefined()
  })
})

describe('a held key', () => {
  it('picks, moves on and sends nothing on an auto-repeat, but keeps the key from its default', () => {
    for (const name of [' ', 'Enter', '1']) {
      expect(questionKeyCommand(key(name, { repeat: true }), 'options', single, 0)).toEqual({ type: 'ignore' })
    }
    expect(questionKeyCommand(key('Enter', { repeat: true }), 'other', single, 3)).toEqual({ type: 'ignore' })
    expect(questionKeyCommand(key('Enter', { repeat: true, ctrlKey: true }), 'options', single, 0)).toEqual({ type: 'ignore' })
  })

  it('still moves the cursor and the question: that answers nothing', () => {
    expect(questionKeyCommand(key('ArrowDown', { repeat: true }), 'options', single, 0)).toEqual({ type: 'cursor', to: 1 })
    expect(questionKeyCommand(key('ArrowRight', { repeat: true }), 'options', single, 0)).toEqual({ type: 'question', step: 1 })
  })
})

describe('the keys in the free text field', () => {
  it('goes back to the last option on ArrowUp and moves on on Enter', () => {
    expect(questionKeyCommand(key('ArrowUp'), 'other', single, 3)).toEqual({ type: 'cursor', to: 2 })
    expect(questionKeyCommand(key('Enter'), 'other', single, 3)).toEqual({ type: 'move-on', finish: true })
  })

  it('leaves the side arrows, Space and the digits to the text', () => {
    for (const name of ['ArrowLeft', 'ArrowRight', ' ', '1', 'a']) {
      expect(questionKeyCommand(key(name), 'other', single, 3)).toBeUndefined()
    }
  })

  it('still sends on Ctrl+Enter and leaves on Esc', () => {
    expect(questionKeyCommand(key('Enter', { ctrlKey: true }), 'other', single, 3)).toEqual({ type: 'submit' })
    expect(questionKeyCommand(key('Escape'), 'other', single, 3)).toEqual({ type: 'leave' })
  })
})

describe('the keys on the submit button', () => {
  it('leaves Space and Enter to the button, and keeps the arrows and the digits', () => {
    expect(questionKeyCommand(key(' '), 'elsewhere', single, 0)).toBeUndefined()
    expect(questionKeyCommand(key('Enter'), 'elsewhere', single, 0)).toBeUndefined()
    expect(questionKeyCommand(key('ArrowRight'), 'elsewhere', single, 0)).toEqual({ type: 'question', step: 1 })
    expect(questionKeyCommand(key('2'), 'elsewhere', single, 0)).toEqual({ type: 'select', option: 1, moveOn: true })
  })
})
