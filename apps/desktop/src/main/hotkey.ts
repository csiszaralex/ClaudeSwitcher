import type { HotkeyRegistration, HotkeyStatus } from '../shared/hotkey-status.js'
import { DEFAULT_HOTKEY } from '../shared/settings.js'

// The registration result types and their Hungarian text are in `shared/hotkey-status.ts`: the
// setup window shows them too.

/** A `globalShortcut.register` alakja, hogy a foglalás Electron nélkül tesztelhető legyen. */
export type RegisterAccelerator = (accelerator: string, handler: () => void) => boolean

/**
 * Lefoglal egy gyorsbillentyűt, és soha nem dob.
 *
 * A gyorsbillentyű a felhasználó által szerkesztett config.json-ból jön (a `loadConfig` csak azt
 * nézi, hogy nem üres szöveg), ezért egy dobás itt nem programozási hiba, hanem egy elgépelés.
 * Korábban az `app.whenReady()` hibakezelőjéhez jutott, és az app el sem indult.
 */
export function registerHotkey(register: RegisterAccelerator, accelerator: string, handler: () => void): HotkeyStatus {
  try {
    return register(accelerator, handler) ? 'registered' : 'taken'
  } catch (error) {
    console.error(`[hotkey] invalid accelerator "${accelerator}"`, error)
    return 'invalid'
  }
}

/**
 * Lefoglalja a beállított gyorsbillentyűt; ha érvénytelen, a `DEFAULT_HOTKEY`-t. Így egy elgépelés
 * után is van működő gyorsbillentyű, és a tálca megmondja, mit kell javítani (lásd `hotkeyLabel`).
 * Foglalt billentyűnél nem lépünk az alapértékre: az érvényes, csak most nem elérhető, és a
 * felhasználó szándékosan választotta.
 */
export function registerHotkeyOrDefault(
  register: RegisterAccelerator,
  accelerator: string,
  handler: () => void,
): HotkeyRegistration {
  const status = registerHotkey(register, accelerator, handler)
  if (status !== 'invalid' || accelerator === DEFAULT_HOTKEY) return { requested: accelerator, status }
  return {
    requested: accelerator,
    status,
    fallback: { accelerator: DEFAULT_HOTKEY, status: registerHotkey(register, DEFAULT_HOTKEY, handler) },
  }
}

/** The tray line (`hotkeyLabel`) for the startup log, in English like the other log lines. */
export function hotkeyLogText(registration: HotkeyRegistration): string {
  const { requested, status, fallback } = registration
  if (status === 'registered') return `hotkey ${requested} registered`
  if (status === 'taken') return `hotkey ${requested} NOT registered (taken by another application)`
  const fallbackText =
    fallback === undefined
      ? 'no default to fall back to'
      : `default ${fallback.accelerator} ${fallback.status === 'registered' ? 'registered' : `NOT registered (${fallback.status})`}`
  return `hotkey ${requested} INVALID; ${fallbackText}`
}

/**
 * The result of a live switch. `registration` is what holds afterwards: `next` when switched,
 * otherwise `current` registered again. `attempted` is what became of `next`.
 */
export type HotkeySwitch =
  | { switched: true; registration: HotkeyRegistration }
  | { switched: false; registration: HotkeyRegistration; attempted: Exclude<HotkeyStatus, 'registered'> }

/**
 * Moves the global shortcut from `current` to `next` while the app runs, and never throws.
 * If `next` does not register (taken or invalid), `current` is registered again, so the user is
 * never left without a working hotkey because of a bad choice.
 */
export function switchHotkey(
  deps: { register: RegisterAccelerator; unregister: (accelerator: string) => void },
  current: string,
  next: string,
  handler: () => void,
): HotkeySwitch {
  if (next === current) return { registration: { requested: current, status: 'registered' }, switched: true }
  try {
    deps.unregister(current)
  } catch (error) {
    console.error(`[hotkey] could not unregister "${current}"`, error)
  }
  const status = registerHotkey(deps.register, next, handler)
  if (status === 'registered') return { registration: { requested: next, status }, switched: true }
  console.error(`[hotkey] "${next}" is ${status}; keeping "${current}"`)
  return {
    registration: { requested: current, status: registerHotkey(deps.register, current, handler) },
    switched: false,
    attempted: status,
  }
}
