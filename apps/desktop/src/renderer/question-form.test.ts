import { buildHookResponse } from '@claudeswitcher/core/browser'
import { parsedPayload } from '@claudeswitcher/core/testing'
import { describe, expect, it } from 'vitest'
import { buildAnswers, initialFormState, isComplete, setOtherText, toggleOption } from './question-form.js'

// A spike valódi kérdései: egy többválasztós (gyümölcsök) és egy egyválasztós (szín).
const ask = parsedPayload('permissionRequest_askMulti')
const [fruits, colour] = ask.questions
if (fruits === undefined || colour === undefined) throw new Error('fixture has two questions')

describe('question form', () => {
  it('starts incomplete — an empty answer must not reach the hook', () => {
    expect(isComplete(ask.questions, initialFormState(ask.questions))).toBe(false)
  })

  it('is never complete with no questions — an unreadable question must not be sent as answered', () => {
    expect(isComplete([], initialFormState([]))).toBe(false)
  })

  it('joins multi-select labels in option order, not click order', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Banán')
    state = toggleOption(state, fruits, 'Alma')
    expect(buildAnswers(ask.questions, state)['Milyen gyümölcsöket szeretsz?']).toBe('Alma, Banán')
  })

  it('toggles a multi-select option off again', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Alma')
    state = toggleOption(state, fruits, 'Alma')
    expect(buildAnswers(ask.questions, state)['Milyen gyümölcsöket szeretsz?']).toBe('')
  })

  it('adds free text after the chosen options for a multi-select question', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Eper')
    state = setOtherText(state, fruits, '  kiwi ')
    expect(buildAnswers(ask.questions, state)['Milyen gyümölcsöket szeretsz?']).toBe('Eper, kiwi')
  })

  it('replaces the previous choice for a single-select question', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, colour, 'Piros')
    state = toggleOption(state, colour, 'Kék')
    expect(buildAnswers(ask.questions, state)['Mi a kedvenc színed?']).toBe('Kék')
  })

  it('lets free text replace the chosen option for a single-select question', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, colour, 'Piros')
    state = setOtherText(state, colour, 'levendula')
    expect(buildAnswers(ask.questions, state)['Mi a kedvenc színed?']).toBe('levendula')
  })

  it('produces answers the core accepts as a complete reply', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Alma')
    state = toggleOption(state, colour, 'Zöld')
    expect(isComplete(ask.questions, state)).toBe(true)
    const result = buildHookResponse(ask, { type: 'answer', answers: buildAnswers(ask.questions, state) })
    expect(result.ok).toBe(true)
  })
})
