import type { HotkeyStatus } from '../shared/hotkey-status.js'
import { acceleratorFromKey } from '../shared/accelerator.js'
import { registerHotkey, type RegisterAccelerator } from './hotkey.js'

/**
 * The Alt+Space family, registered as temporary global shortcuts while a capture runs. Windows
 * handles Alt+Space (the window's system menu) before the page and before `before-input-event`
 * (measured by Alex in the built app, 2026-11-01: neither `before-input-event` nor
 * `system-context-menu` stopped it). A global shortcut (RegisterHotKey) should be delivered before the
 * system menu, so these are captured that way (measured by Alex on 2026-11-01: the Alt+Space
 * family is captured through these temporary global shortcuts).
 * Written exactly as `acceleratorFromKey` writes them, so a captured value round-trips.
 */
export const CAPTURE_SHORTCUTS: readonly string[] = [
  'Alt+Space',
  'Shift+Alt+Space',
  'Control+Alt+Space',
  'Control+Shift+Alt+Space',
  'Alt+Super+Space',
  'Shift+Alt+Super+Space',
  'Control+Alt+Super+Space',
  'Control+Shift+Alt+Super+Space',
]

/**
 * Suspends the app's own global hotkey while the setup window captures a new one. Otherwise the
 * held hotkey fires during capture (the overlay pops up) instead of reaching the window.
 */
export interface HotkeyCapture {
  /**
   * Unregisters the held hotkey, then registers the temporaries. A second start while active does
   * nothing.
   */
  start(): void
  /**
   * Unregisters exactly the temporaries that registered, then registers the held hotkey again (last,
   * so a held hotkey that is also a temporary ends up held), and ends the capture. Returns what became of it, or
   * `undefined` when no capture was active. Every path out of a capture (save, Escape, blur,
   * window close) ends here, so the hotkey is never left unregistered.
   */
  stop(): HotkeyStatus | undefined
  active(): boolean
}

export function createHotkeyCapture(deps: {
  register: RegisterAccelerator
  unregister: (accelerator: string) => void
  /** The accelerator the app holds right now. */
  held: () => string
  handler: () => void
  /** Registered for the capture's duration (`CAPTURE_SHORTCUTS`); one that fails is skipped. */
  temporaries: readonly string[]
  /** A temporary fired: that accelerator is the captured value. */
  onTemporary: (accelerator: string) => void
}): HotkeyCapture {
  let active = false
  let registeredTemporaries: string[] = []
  const unregister = (accelerator: string): void => {
    try {
      deps.unregister(accelerator)
    } catch (error) {
      console.error(`[hotkey] could not unregister "${accelerator}"`, error)
    }
  }
  return {
    start() {
      if (active) return
      active = true
      unregister(deps.held())
      registeredTemporaries = deps.temporaries.filter(
        (accelerator) =>
          registerHotkey(deps.register, accelerator, () => {
            deps.onTemporary(accelerator)
          }) === 'registered',
      )
    },
    stop() {
      if (!active) return undefined
      active = false
      for (const accelerator of registeredTemporaries) unregister(accelerator)
      registeredTemporaries = []
      return registerHotkey(deps.register, deps.held(), deps.handler)
    },
    active: () => active,
  }
}

/** The fields of Electron's `Input` (`before-input-event`) that a capture reads. */
export interface CaptureInput {
  type: string
  key: string
  code: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export type CaptureStep = { kind: 'ignore' } | { kind: 'cancel' } | { kind: 'captured'; accelerator: string }

/** What one key event means during a capture: Escape cancels, a usable combination ends it. */
export function captureStep(input: CaptureInput): CaptureStep {
  if (input.type !== 'keyDown') return { kind: 'ignore' }
  if (input.code === 'Escape') return { kind: 'cancel' }
  const accelerator = acceleratorFromKey({
    code: input.code,
    key: input.key,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    metaKey: input.meta,
  })
  return accelerator === undefined ? { kind: 'ignore' } : { kind: 'captured', accelerator }
}
