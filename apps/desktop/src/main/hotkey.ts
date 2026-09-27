import { globalShortcut } from 'electron'

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
