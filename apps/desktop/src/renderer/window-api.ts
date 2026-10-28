import type { ClaudeSwitcherApi } from '../preload/api.js'

/**
 * A preload által kitett API típusa a rendererben. Egyetlen forrása a `ClaudeSwitcherApi`, amit a
 * preload `api` objektuma megvalósít; innen csak típus jön, a renderer csomagjába kód nem kerül.
 */
declare global {
  interface Window {
    claudeswitcher: ClaudeSwitcherApi
  }
}

export {}
