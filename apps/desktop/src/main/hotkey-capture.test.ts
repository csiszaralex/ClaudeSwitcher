import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceleratorFromKey } from '../shared/accelerator.js'
import { CAPTURE_SHORTCUTS, captureStep, createHotkeyCapture } from './hotkey-capture.js'

/** A fake `globalShortcut` that tracks what is registered and logs every call. */
function fakeShortcuts(options: { taken?: string[]; failUnregister?: boolean } = {}): {
  deps: { register: (accelerator: string, handler: () => void) => boolean; unregister: (accelerator: string) => void }
  registered: Set<string>
  calls: string[]
  /** Fires a registered shortcut, as Windows would. */
  press: (accelerator: string) => void
} {
  const registered = new Set<string>(['F8'])
  const handlers = new Map<string, () => void>()
  const calls: string[] = []
  return {
    deps: {
      register: (accelerator, handler) => {
        calls.push(`register ${accelerator}`)
        if (options.taken?.includes(accelerator) === true) return false
        registered.add(accelerator)
        handlers.set(accelerator, handler)
        return true
      },
      unregister: (accelerator) => {
        calls.push(`unregister ${accelerator}`)
        if (options.failUnregister === true) throw new Error('unregister failed')
        registered.delete(accelerator)
      },
    },
    registered,
    calls,
    press: (accelerator) => {
      if (registered.has(accelerator)) handlers.get(accelerator)?.()
    },
  }
}

const noop = (): void => undefined
const NO_TEMPORARIES = { temporaries: [], onTemporary: noop }

describe('createHotkeyCapture', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suspends the held hotkey while capturing and registers it again on stop', () => {
    const { deps, registered, calls } = fakeShortcuts()
    const capture = createHotkeyCapture({ ...deps, ...NO_TEMPORARIES, held: () => 'F8', handler: noop })
    capture.start()
    expect(capture.active()).toBe(true)
    expect(registered.has('F8')).toBe(false)
    expect(capture.stop()).toBe('registered')
    expect(capture.active()).toBe(false)
    expect(registered.has('F8')).toBe(true)
    expect(calls).toEqual(['unregister F8', 'register F8'])
  })

  it('a second start or a stop without start changes nothing', () => {
    const { deps, calls } = fakeShortcuts()
    const capture = createHotkeyCapture({ ...deps, ...NO_TEMPORARIES, held: () => 'F8', handler: noop })
    expect(capture.stop()).toBeUndefined()
    capture.start()
    capture.start()
    capture.stop()
    expect(capture.stop()).toBeUndefined()
    expect(calls).toEqual(['unregister F8', 'register F8'])
  })

  it('never leaves the hotkey unregistered after any start and stop sequence', () => {
    const { deps, registered } = fakeShortcuts()
    const capture = createHotkeyCapture({ ...deps, ...NO_TEMPORARIES, held: () => 'F8', handler: noop })
    for (const step of ['start', 'stop', 'start', 'start', 'stop', 'stop', 'start', 'stop'] as const) {
      if (step === 'start') capture.start()
      else capture.stop()
      if (!capture.active()) expect(registered.has('F8')).toBe(true)
    }
  })

  it('registers whatever is held at stop time', () => {
    const { deps, registered } = fakeShortcuts()
    let held = 'F8'
    const capture = createHotkeyCapture({ ...deps, ...NO_TEMPORARIES, held: () => held, handler: noop })
    capture.start()
    held = 'F9'
    capture.stop()
    expect(registered.has('F9')).toBe(true)
  })

  it('still registers again on stop when unregistering threw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps, calls } = fakeShortcuts({ failUnregister: true })
    const capture = createHotkeyCapture({ ...deps, ...NO_TEMPORARIES, held: () => 'F8', handler: noop })
    capture.start()
    expect(capture.active()).toBe(true)
    capture.stop()
    expect(calls.at(-1)).toBe('register F8')
  })

  it('reports when the held hotkey was taken meanwhile', () => {
    const { deps } = fakeShortcuts({ taken: ['F8'] })
    const capture = createHotkeyCapture({ ...deps, ...NO_TEMPORARIES, held: () => 'F8', handler: noop })
    capture.start()
    expect(capture.stop()).toBe('taken')
    expect(capture.active()).toBe(false)
  })
})

describe('createHotkeyCapture temporaries', () => {
  const TEMPS = ['Alt+Space', 'Shift+Alt+Space', 'Control+Alt+Space']

  it('registers the temporaries after suspending the held hotkey, and unregisters them all on stop', () => {
    const { deps, registered, calls } = fakeShortcuts()
    const capture = createHotkeyCapture({ ...deps, temporaries: TEMPS, onTemporary: noop, held: () => 'F8', handler: noop })
    capture.start()
    expect(calls).toEqual(['unregister F8', 'register Alt+Space', 'register Shift+Alt+Space', 'register Control+Alt+Space'])
    capture.stop()
    for (const temporary of TEMPS) expect(registered.has(temporary)).toBe(false)
    expect(calls.at(-1)).toBe('register F8')
  })

  it('a temporary that fires yields its accelerator', () => {
    const { deps, press } = fakeShortcuts()
    const fired: string[] = []
    const capture = createHotkeyCapture({
      ...deps,
      temporaries: TEMPS,
      onTemporary: (accelerator) => fired.push(accelerator),
      held: () => 'F8',
      handler: noop,
    })
    capture.start()
    press('Shift+Alt+Space')
    expect(fired).toEqual(['Shift+Alt+Space'])
  })

  it('does not unregister a temporary that failed to register', () => {
    const { deps, calls } = fakeShortcuts({ taken: ['Control+Alt+Space'] })
    const capture = createHotkeyCapture({ ...deps, temporaries: TEMPS, onTemporary: noop, held: () => 'F8', handler: noop })
    capture.start()
    calls.length = 0
    capture.stop()
    expect(calls).toEqual(['unregister Alt+Space', 'unregister Shift+Alt+Space', 'register F8'])
  })

  it('registers the held hotkey last, even when it is one of the temporaries', () => {
    const { deps, registered, calls } = fakeShortcuts()
    const capture = createHotkeyCapture({
      ...deps,
      temporaries: TEMPS,
      onTemporary: noop,
      held: () => 'Shift+Alt+Space',
      handler: noop,
    })
    capture.start()
    capture.stop()
    expect(calls.at(-1)).toBe('register Shift+Alt+Space')
    expect(registered.has('Shift+Alt+Space')).toBe(true)
    expect(registered.has('Alt+Space')).toBe(false)
  })
})

describe('CAPTURE_SHORTCUTS', () => {
  it('is written exactly as acceleratorFromKey writes it, so a captured value round-trips', () => {
    for (const accelerator of CAPTURE_SHORTCUTS) {
      const parts = accelerator.split('+')
      const fromKey = acceleratorFromKey({
        code: 'Space',
        key: ' ',
        ctrlKey: parts.includes('Control'),
        shiftKey: parts.includes('Shift'),
        altKey: parts.includes('Alt'),
        metaKey: parts.includes('Super'),
      })
      expect(fromKey).toBe(accelerator)
    }
  })

  it('covers Alt+Space with every other modifier combination', () => {
    expect(CAPTURE_SHORTCUTS).toHaveLength(8)
    expect(new Set(CAPTURE_SHORTCUTS).size).toBe(8)
    for (const accelerator of CAPTURE_SHORTCUTS) expect(accelerator).toMatch(/(^|\+)Alt\+(Super\+)?Space$/)
  })
})

const KEY = { type: 'keyDown', key: '', code: '', control: false, shift: false, alt: false, meta: false }

describe('captureStep', () => {
  it('captures Alt+Space combinations, which the window would otherwise give to the system menu', () => {
    expect(captureStep({ ...KEY, code: 'Space', key: ' ', shift: true, alt: true })).toEqual({
      kind: 'captured',
      accelerator: 'Shift+Alt+Space',
    })
    expect(captureStep({ ...KEY, code: 'Space', key: ' ', alt: true })).toEqual({ kind: 'captured', accelerator: 'Alt+Space' })
  })

  it('cancels on Escape', () => {
    expect(captureStep({ ...KEY, code: 'Escape', key: 'Escape' })).toEqual({ kind: 'cancel' })
  })

  it('ignores key ups, modifiers alone and keys that are no hotkey', () => {
    expect(captureStep({ ...KEY, type: 'keyUp', code: 'KeyK', key: 'k', control: true })).toEqual({ kind: 'ignore' })
    expect(captureStep({ ...KEY, code: 'AltLeft', key: 'Alt', alt: true })).toEqual({ kind: 'ignore' })
    expect(captureStep({ ...KEY, code: 'KeyK', key: 'k' })).toEqual({ kind: 'ignore' })
  })
})
