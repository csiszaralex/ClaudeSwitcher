import type { ClaudeSwitcherApi } from '../preload/api.js'

/**
 * The type of the API the preload exposes, in the renderer. Its single source is
 * `ClaudeSwitcherApi`, which the preload's `api` object implements; only a type comes from there,
 * no code goes into the renderer bundle.
 */
declare global {
  interface Window {
    claudeswitcher: ClaudeSwitcherApi
  }
}

export {}
