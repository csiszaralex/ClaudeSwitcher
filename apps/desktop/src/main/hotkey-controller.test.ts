import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HotkeyRegistration } from '../shared/hotkey-status.js'
import { DEFAULT_HOTKEY } from '../shared/settings.js'
import { createHotkeyController, type HotkeyChange } from './hotkey-controller.js'

/**
 * A fake `globalShortcut`, as in `hotkey-capture.test.ts`, plus `invalid` (Electron throws on an
 * accelerator it cannot parse) and `take` (another application grabs a free accelerator).
 */
function fakeShortcuts(options: { taken?: string[]; invalid?: string[] } = {}): {
  deps: { register: (accelerator: string, handler: () => void) => boolean; unregister: (accelerator: string) => void }
  registered: Set<string>
  calls: string[]
  press: (accelerator: string) => void
  take: (accelerator: string) => void
} {
  const registered = new Set<string>()
  const taken = new Set<string>(options.taken)
  const handlers = new Map<string, () => void>()
  const calls: string[] = []
  return {
    deps: {
      register: (accelerator, handler) => {
        calls.push(`register ${accelerator}`)
        if (options.invalid?.includes(accelerator) === true) throw new Error(`cannot parse ${accelerator}`)
        if (taken.has(accelerator)) return false
        registered.add(accelerator)
        handlers.set(accelerator, handler)
        return true
      },
      unregister: (accelerator) => {
        calls.push(`unregister ${accelerator}`)
        registered.delete(accelerator)
      },
    },
    registered,
    calls,
    press: (accelerator) => {
      if (registered.has(accelerator)) handlers.get(accelerator)?.()
    },
    take: (accelerator) => {
      taken.add(accelerator)
    },
  }
}

const noop = (): void => undefined

function setup(
  options: { configured?: string; taken?: string[]; invalid?: string[]; defer?: (fn: () => void) => void } = {},
): {
  shortcuts: ReturnType<typeof fakeShortcuts>
  controller: ReturnType<typeof createHotkeyController>
  changes: { registration: HotkeyRegistration; change: HotkeyChange }[]
  captured: string[]
  fired: () => number
} {
  const shortcuts = fakeShortcuts({ taken: options.taken ?? [], invalid: options.invalid ?? [] })
  const changes: { registration: HotkeyRegistration; change: HotkeyChange }[] = []
  const captured: string[] = []
  let fires = 0
  const controller = createHotkeyController({
    ...shortcuts.deps,
    configured: options.configured ?? 'F8',
    onFire: () => {
      fires += 1
    },
    onRegistrationChanged: (registration, change) => changes.push({ registration, change }),
    onCaptured: (accelerator) => captured.push(accelerator),
    ...(options.defer === undefined ? {} : { defer: options.defer }),
  })
  return { shortcuts, controller, changes, captured, fired: () => fires }
}

describe('createHotkeyController', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(noop)
    vi.spyOn(console, 'error').mockImplementation(noop)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the fallback when the configured hotkey is invalid at start', () => {
    const { controller, shortcuts, changes } = setup({ configured: 'Shift+Alt+Spcae', invalid: ['Shift+Alt+Spcae'] })
    expect(controller.registration()).toEqual({
      requested: 'Shift+Alt+Spcae',
      status: 'invalid',
      fallback: { accelerator: DEFAULT_HOTKEY, status: 'registered' },
    })
    expect(shortcuts.registered).toEqual(new Set([DEFAULT_HOTKEY]))
    // The startup result reaches the tray through `createTray`, not as a change.
    expect(changes).toEqual([])
  })

  it('keeps a taken configured hotkey at start, without falling back', () => {
    const { controller, shortcuts } = setup({ taken: ['F8'] })
    expect(controller.registration()).toEqual({ requested: 'F8', status: 'taken' })
    expect(shortcuts.registered.size).toBe(0)
  })

  it('fires the overlay toggle on the held hotkey', () => {
    const { shortcuts, fired } = setup()
    shortcuts.press('F8')
    expect(fired()).toBe(1)
  })

  it('ends a running capture before a switch', () => {
    const { controller, shortcuts } = setup()
    controller.startCapture()
    expect(controller.capturing()).toBe(true)
    shortcuts.calls.length = 0
    const result = controller.switchTo('F9')
    expect(result).toEqual({ switched: true, registration: { requested: 'F9', status: 'registered' } })
    expect(controller.capturing()).toBe(false)
    // The capture registers F8 again first, then the switch moves it to F9: nothing is left behind.
    expect(shortcuts.calls.slice(0, 1)).toEqual(['unregister Alt+Space'])
    expect(shortcuts.calls.slice(-3)).toEqual(['register F8', 'unregister F8', 'register F9'])
    expect(shortcuts.registered).toEqual(new Set(['F9']))
  })

  it('reports a successful switch without asking the window to reload', () => {
    const { controller, changes } = setup()
    controller.switchTo('F9')
    expect(controller.registration()).toEqual({ requested: 'F9', status: 'registered' })
    expect(changes).toEqual([{ registration: { requested: 'F9', status: 'registered' }, change: 'switched' }])
  })

  it('keeps the held hotkey and reports it after a refused switch', () => {
    const { controller, shortcuts, changes } = setup({ taken: ['F9'] })
    const result = controller.switchTo('F9')
    expect(result).toEqual({ switched: false, registration: { requested: 'F8', status: 'registered' }, attempted: 'taken' })
    expect(controller.registration()).toEqual({ requested: 'F8', status: 'registered' })
    expect(changes).toEqual([{ registration: { requested: 'F8', status: 'registered' }, change: 'refused' }])
    // The held hotkey did not move: the next switch starts from F8.
    shortcuts.calls.length = 0
    controller.switchTo('F10')
    expect(shortcuts.calls).toEqual(['unregister F8', 'register F10'])
  })

  it('re-registers the held hotkey when a capture ends', () => {
    const { controller, shortcuts, changes } = setup()
    controller.startCapture()
    expect(shortcuts.registered.has('F8')).toBe(false)
    controller.endCapture()
    expect(controller.capturing()).toBe(false)
    expect(shortcuts.registered).toEqual(new Set(['F8']))
    expect(controller.registration()).toEqual({ requested: 'F8', status: 'registered' })
    // Registered as before: nothing to report.
    expect(changes).toEqual([])
  })

  it('reports the fallback when the held hotkey was taken during a capture', () => {
    const { controller, shortcuts, changes } = setup({ configured: 'Shift+Alt+Spcae', invalid: ['Shift+Alt+Spcae'] })
    controller.startCapture()
    shortcuts.take(DEFAULT_HOTKEY)
    controller.endCapture()
    // The held hotkey is the fallback, not the configured value the startup registration reported.
    const expected: HotkeyRegistration = { requested: DEFAULT_HOTKEY, status: 'taken' }
    expect(controller.registration()).toEqual(expected)
    expect(changes).toEqual([{ registration: expected, change: 'capture-ended' }])
  })

  it('an end without a running capture changes nothing', () => {
    const { controller, shortcuts, changes } = setup()
    shortcuts.calls.length = 0
    controller.endCapture()
    expect(shortcuts.calls).toEqual([])
    expect(changes).toEqual([])
  })

  it('delivers a temporary-shortcut capture through defer', () => {
    const deferred: (() => void)[] = []
    const { controller, shortcuts, captured } = setup({ defer: (fn) => deferred.push(fn) })
    controller.startCapture()
    shortcuts.press('Control+Alt+Space')
    // Ending inside the shortcut's own callback would unregister that very shortcut.
    expect(controller.capturing()).toBe(true)
    expect(captured).toEqual([])
    expect(deferred).toHaveLength(1)
    deferred[0]!()
    expect(controller.capturing()).toBe(false)
    expect(captured).toEqual(['Control+Alt+Space'])
    expect(shortcuts.registered).toEqual(new Set(['F8']))
  })

  it('drops a deferred capture when the capture ended meanwhile', () => {
    const deferred: (() => void)[] = []
    const { controller, shortcuts, captured } = setup({ defer: (fn) => deferred.push(fn) })
    controller.startCapture()
    shortcuts.press('Alt+Space')
    controller.endCapture()
    deferred[0]!()
    expect(captured).toEqual([])
  })
})
