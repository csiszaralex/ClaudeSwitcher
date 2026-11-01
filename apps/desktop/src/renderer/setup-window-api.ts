import type { SetupApi } from '../preload/setup-api.js'

/**
 * The setup preload's API in the renderer. Its one source is `SetupApi`, which `preload/setup.ts`
 * implements; only a type comes from there, no code. Only the setup page has it at run time: the
 * overlay's preload does not expose it.
 */
declare global {
  interface Window {
    claudeswitcherSetup: SetupApi
  }
}

export {}
