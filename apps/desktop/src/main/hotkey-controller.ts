import type { HotkeyRegistration } from '../shared/hotkey-status.js'
import { CAPTURE_SHORTCUTS, createHotkeyCapture } from './hotkey-capture.js'
import { hotkeyLogText, registerHotkeyOrDefault, switchHotkey, type HotkeySwitch, type RegisterAccelerator } from './hotkey.js'

/**
 * Why the registration that holds changed:
 * - `capture-ended`: a capture ended and the held hotkey could not be registered again (typically
 *   another application took it meanwhile);
 * - `switched`: a live switch moved the hotkey. The settings change that follows reloads the window;
 * - `refused`: a live switch was refused and the held hotkey registered again. Nothing is applied,
 *   so no settings change follows: the window has to be told directly.
 */
export type HotkeyChange = 'capture-ended' | 'switched' | 'refused'

/**
 * The app's global hotkey: the startup registration, the capture for the setup window, and the
 * live switch. It keeps two things consistent: the accelerator it holds, and the registration it
 * reports. Every member is a function property, so it can be passed on unbound.
 */
export interface HotkeyController {
  /** The registration that holds now: what `setup:load` and the tray show. */
  readonly registration: () => HotkeyRegistration
  /**
   * The setup window's hotkey change (`saveSetup`'s `switchHotkey`). It ends a running capture first.
   * The held hotkey moves only when the switch succeeded.
   */
  readonly switchTo: (next: string) => HotkeySwitch
  /** Suspends the held hotkey and registers the temporary capture shortcuts (`CAPTURE_SHORTCUTS`). */
  readonly startCapture: () => void
  /** Every end of a capture comes here. Does nothing when no capture is running. */
  readonly endCapture: () => void
  readonly capturing: () => boolean
}

/** The accelerator the app actually holds: the configured one, or the default it fell back to. */
function heldAccelerator(registration: HotkeyRegistration): string {
  return registration.status !== 'invalid' || registration.fallback === undefined
    ? registration.requested
    : registration.fallback.accelerator
}

/** Registers `configured` (or the default, see `registerHotkeyOrDefault`) at once. */
export function createHotkeyController(deps: {
  register: RegisterAccelerator
  unregister: (accelerator: string) => void
  configured: string
  /** The held hotkey fired. */
  onFire: () => void
  /** Not called for the startup registration: that one is read through `registration()`. */
  onRegistrationChanged: (registration: HotkeyRegistration, change: HotkeyChange) => void
  /** A temporary capture shortcut fired: that accelerator is the captured combination. */
  onCaptured: (accelerator: string) => void
  /** Runs a function on a later tick; `setImmediate` unless a test replaces it. */
  defer?: (fn: () => void) => void
}): HotkeyController {
  const defer =
    deps.defer ??
    ((fn: () => void): void => {
      setImmediate(fn)
    })
  let current = registerHotkeyOrDefault(deps.register, deps.configured, deps.onFire)
  let held = heldAccelerator(current)

  const capture = createHotkeyCapture({
    register: deps.register,
    unregister: deps.unregister,
    held: () => held,
    handler: deps.onFire,
    temporaries: CAPTURE_SHORTCUTS,
    // Ended on a later tick, outside the shortcut's own callback, because ending the capture
    // unregisters that very shortcut.
    onTemporary: (accelerator) => {
      defer(() => {
        if (!capture.active()) return
        endCapture()
        deps.onCaptured(accelerator)
      })
    },
  })

  const endCapture = (): void => {
    const status = capture.stop()
    if (status === undefined || status === 'registered') return
    current = { requested: held, status }
    deps.onRegistrationChanged(current, 'capture-ended')
    console.log(`[claudeswitcher] after capture: ${hotkeyLogText(current)}`)
  }

  return {
    registration: () => current,
    switchTo: (next) => {
      // A capture still running would register the held hotkey again on top of the switch.
      endCapture()
      const result = switchHotkey({ register: deps.register, unregister: deps.unregister }, held, next, deps.onFire)
      current = result.registration
      if (result.switched) held = next
      deps.onRegistrationChanged(result.registration, result.switched ? 'switched' : 'refused')
      console.log(`[claudeswitcher] ${hotkeyLogText(result.registration)}`)
      return result
    },
    startCapture: () => {
      capture.start()
    },
    endCapture,
    capturing: () => capture.active(),
  }
}
