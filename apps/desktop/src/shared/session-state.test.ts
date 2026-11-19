import { describe, expect, it } from 'vitest'
import { sessionState } from './session-state.js'

const held = (kind: 'tool' | 'edit' | 'question' | 'plan') => ({ kind, released: false })
const released = (kind: 'tool' | 'edit' | 'question' | 'plan') => ({ kind, released: true })

describe('sessionState', () => {
  it('is choice when a request the app can decide asks for a choice', () => {
    expect(sessionState('waiting', [held('tool'), held('question')])).toBe('choice')
    expect(sessionState('waiting', [held('plan')])).toBe('choice')
  })

  it('is yes-no for a held yes/no request, and ignores a released choice beside it', () => {
    expect(sessionState('waiting', [held('edit')])).toBe('yes-no')
    expect(sessionState('waiting', [released('question'), held('tool')])).toBe('yes-no')
  })

  it('is released when every request is released, whatever the status', () => {
    expect(sessionState('waiting', [released('tool')])).toBe('released')
    expect(sessionState('working', [released('plan'), released('edit')])).toBe('released')
  })

  it('is yes-no for a wait without a request of its own', () => {
    expect(sessionState('waiting', [])).toBe('yes-no')
  })

  it('is working for a running session without requests', () => {
    expect(sessionState('working', [])).toBe('working')
  })

  it('is rest for an idle session without requests', () => {
    expect(sessionState('idle', [])).toBe('rest')
  })
})
