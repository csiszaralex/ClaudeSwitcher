import { describe, expect, it } from 'vitest'
import { isChoiceKind } from './request-kind.js'

describe('isChoiceKind', () => {
  it('is false for the yes/no kinds and true for a question and a plan', () => {
    expect(isChoiceKind('tool')).toBe(false)
    expect(isChoiceKind('edit')).toBe(false)
    expect(isChoiceKind('question')).toBe(true)
    expect(isChoiceKind('plan')).toBe(true)
  })
})
