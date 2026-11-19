import { describe, expect, it, vi } from 'vitest'
import { createFocusReturn } from './focus-return.js'

/** A focus return over invented window names, recording every step in order. */
function recorder(foreground: string | undefined) {
  const steps: string[] = []
  const focusReturn = createFocusReturn<string>({
    capture: () => foreground,
    restore: (window) => {
      steps.push(`restore ${window}`)
      return Promise.resolve(true)
    },
  })
  const hide = (): void => {
    steps.push('hide')
  }
  return { steps, focusReturn, hide }
}

describe('createFocusReturn', () => {
  it('gives the focus back to the remembered window, before hiding the overlay', async () => {
    const { steps, focusReturn, hide } = recorder('editor')
    focusReturn.remember()
    await focusReturn.dismiss(true, hide)
    expect(steps).toEqual(['restore editor', 'hide'])
  })

  it('only hides when the overlay does not have the focus', async () => {
    const { steps, focusReturn, hide } = recorder('editor')
    focusReturn.remember()
    await focusReturn.dismiss(false, hide)
    expect(steps).toEqual(['hide'])
  })

  it('only hides when nothing worth giving back was in front', async () => {
    const { steps, focusReturn, hide } = recorder(undefined)
    focusReturn.remember()
    await focusReturn.dismiss(true, hide)
    expect(steps).toEqual(['hide'])
  })

  it('uses the remembered window once', async () => {
    const { steps, focusReturn, hide } = recorder('editor')
    focusReturn.remember()
    await focusReturn.dismiss(true, hide)
    await focusReturn.dismiss(true, hide)
    expect(steps).toEqual(['restore editor', 'hide', 'hide'])
  })

  it('hides, logs and resolves when giving the focus back throws', async () => {
    const steps: string[] = []
    const focusReturn = createFocusReturn<string>({
      capture: () => 'editor',
      restore: () => Promise.reject(new Error('invented failure')),
    })
    focusReturn.remember()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await focusReturn.dismiss(true, () => {
      steps.push('hide')
    })
    expect(steps).toEqual(['hide'])
    expect(logged).toHaveBeenCalledOnce()
    logged.mockRestore()
  })
})
