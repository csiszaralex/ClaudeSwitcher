import { DEFAULT_HOTKEY } from '../shared/settings.js'

/**
 * Egy gyorsbillentyű foglalásának eredménye:
 * - `registered`: él;
 * - `taken`: egy másik alkalmazás foglalja. Az Electron ilyenkor dokumentáltan NEM dob, hanem
 *   `false`-t ad;
 * - `invalid`: az Electron nem tudta értelmezni (dobott), például egy elgépelt kombinációt a
 *   config.json-ban (`Shift+Alt+Spcae`).
 */
export type HotkeyStatus = 'registered' | 'taken' | 'invalid'

/** A `globalShortcut.register` alakja, hogy a foglalás Electron nélkül tesztelhető legyen. */
export type RegisterAccelerator = (accelerator: string, handler: () => void) => boolean

/** A beállított gyorsbillentyű eredménye, és ha érvénytelen volt, az alapértéké. */
export interface HotkeyRegistration {
  requested: string
  status: HotkeyStatus
  /** Csak `invalid` esetén: az alapértelmezett gyorsbillentyű, amit helyette foglaltunk. */
  fallback?: { accelerator: string; status: HotkeyStatus } | undefined
}

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
    console.error(`[hotkey] invalid accelerator "${accelerator}" in config.json`, error)
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

/** A tálcamenü gyorsbillentyű sora: mi él, és ha valami nem, mit kell javítani. */
export function hotkeyLabel(registration: HotkeyRegistration): string {
  const { requested, status, fallback } = registration
  if (status === 'registered') return `Gyorsbillentyű: ${requested}`
  if (status === 'taken') return `Gyorsbillentyű: ${requested}, FOGLALT, nem működik`
  const invalid = `ÉRVÉNYTELEN gyorsbillentyű: ${requested}`
  if (fallback?.status === 'registered') return `${invalid}, alapérték él (${fallback.accelerator})`
  if (fallback?.status === 'taken') return `${invalid}, az alapérték (${fallback.accelerator}) is FOGLALT`
  return `${invalid}, nincs működő gyorsbillentyű`
}

/** Ugyanez az indulási naplóba, angolul, mint a többi naplósor. */
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
