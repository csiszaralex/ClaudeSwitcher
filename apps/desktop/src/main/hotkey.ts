import { globalShortcut } from 'electron'

/**
 * Az overlay globális gyorsbillentyűje. Egyetlen helyen, hogy egy sorral cserélhető
 * legyen.
 *
 * FIGYELEM: a `Control+Alt` Windowson azonos az `AltGr`-rel. Magyar és sok más európai
 * billentyűzetkiosztáson ez a kombináció globálisan elnyeli az `AltGr+Space`-t: ha
 * valaki `@`-t ír (`AltGr+V`), és még nyomva tartja az AltGr-t, amikor szóközt üt, az
 * overlay felugrik, a szóköz pedig elvész. A spec „pl."-ként említette, a felhasználó
 * ezt választotta — a Task 15 elfogadási tesztjénél döntsön róla.
 */
export const OVERLAY_HOTKEY = 'Control+Alt+Space'

/**
 * Igaz, ha sikerült regisztrálni. Egy másik alkalmazás elveheti a
 * kombinációt — ilyenkor az app fut tovább, csak a hotkey nem él.
 */
export function registerHotkey(accelerator: string, handler: () => void): boolean {
  try {
    return globalShortcut.register(accelerator, handler)
  } catch {
    return false
  }
}
