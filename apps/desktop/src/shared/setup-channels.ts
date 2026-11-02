/**
 * The setup window's IPC channels: the main process handles the requests and sends `changed` and
 * `captured`, the setup preload (`preload/setup.ts`) invokes and listens. Import-free: the preload
 * bundles this module, and the overlay preload must never import it (a chunk shared by the two
 * preloads would not load in a sandboxed preload).
 */
export const SETUP_CHANNELS = {
  load: 'setup:load',
  save: 'setup:save',
  install: 'setup:install',
  uninstall: 'setup:uninstall',
  capture: 'setup:capture',
  /** Pushed when a setting changed elsewhere, for example in the tray. */
  changed: 'setup:changed',
  /** Pushed when a hotkey capture ended, with a `CapturedPayload` (`main/setup-window.ts`). */
  captured: 'setup:captured',
} as const

/** The reply to `install` and `uninstall`. */
export interface InstallReply {
  ok: boolean
  message: string
}
