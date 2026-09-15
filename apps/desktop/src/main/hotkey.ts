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
 * Igaz, ha sikerült regisztrálni.
 *
 * Ha egy másik alkalmazás foglalja a kombinációt, az Electron dokumentáltan NEM dob,
 * hanem `false`-t ad — ilyenkor az app fut tovább, csak a gyorsbillentyű nem él.
 *
 * Szándékosan nincs try/catch. Mivel a „foglalt" eset nem dob, egy kivétel itt csak
 * programozási hibát jelenthet, például egy elgépelt billentyűkombinációt. Ha azt
 * elnyelnénk, a hívó azt naplózná, hogy „egy másik alkalmazás foglalja", ami hamis
 * nyomra vinne. Így a hiba az `app.whenReady()` hibakezelőjéhez jut, és hibadialógust ad.
 */
export function registerHotkey(accelerator: string, handler: () => void): boolean {
  return globalShortcut.register(accelerator, handler)
}
