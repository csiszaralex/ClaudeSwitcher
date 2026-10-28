import type { ClaudeSwitcherApi } from '../preload/index.js'

/**
 * A preload által kitett API típusa a rendererben. Egyetlen forrása a preload `api` objektuma;
 * innen csak típus jön, a renderer csomagjába a preload kódja nem kerül be.
 */
declare global {
  interface Window {
    claudeswitcher: ClaudeSwitcherApi
  }
}

export {}
