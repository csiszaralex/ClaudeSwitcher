/**
 * What a hotkey registration ended in, and the Hungarian text for it. The tray menu and the setup
 * window both show it, so it lives here: compiled by the main and the renderer projects alike, it
 * imports no `node:` module. The registration itself is in `main/hotkey.ts`.
 */

/**
 * - `registered`: it holds;
 * - `taken`: another application holds it. Electron documents that it does NOT throw then, but
 *   returns `false`;
 * - `invalid`: Electron could not parse it (it threw), for example a typo in config.json
 *   (`Shift+Alt+Spcae`).
 */
export type HotkeyStatus = 'registered' | 'taken' | 'invalid'

/** The configured hotkey's result, and if it was invalid, the default's. */
export interface HotkeyRegistration {
  requested: string
  status: HotkeyStatus
  /** Only for `invalid`: the default hotkey registered in its place. */
  fallback?: { accelerator: string; status: HotkeyStatus } | undefined
}

/** The tray menu's hotkey line: what holds, and if something does not, what to fix. */
export function hotkeyLabel(registration: HotkeyRegistration): string {
  const { requested, status, fallback } = registration
  if (status === 'registered') return `Gyorsbillentyű: ${requested}`
  if (status === 'taken') return `Gyorsbillentyű: ${requested}, FOGLALT, nem működik`
  const invalid = `ÉRVÉNYTELEN gyorsbillentyű: ${requested}`
  if (fallback?.status === 'registered') return `${invalid}, alapérték él (${fallback.accelerator})`
  if (fallback?.status === 'taken') return `${invalid}, az alapérték (${fallback.accelerator}) is FOGLALT`
  return `${invalid}, nincs működő gyorsbillentyű`
}

/**
 * Why the setup window could not save a new hotkey (see `switchHotkey`). `kept` is the old
 * hotkey registered again; normally it holds, but another application may have taken it meanwhile.
 */
export function hotkeyRefusal(tried: string, attempted: Exclude<HotkeyStatus, 'registered'>, kept: HotkeyRegistration): string {
  const why =
    attempted === 'taken'
      ? `Ez a gyorsbillentyű foglalt, egy másik alkalmazás használja: ${tried}.`
      : `Ez nem érvényes gyorsbillentyű: ${tried}.`
  const old =
    kept.status === 'registered'
      ? `Marad a régi: ${kept.requested}.`
      : `A régit (${kept.requested}) sem sikerült visszavenni, most nincs működő gyorsbillentyű.`
  return `${why} ${old}`
}
