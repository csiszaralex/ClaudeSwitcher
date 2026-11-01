/** The part of Electron's login item API we use, so autostart is testable without Electron. */
export interface LoginItems {
  get(): { openAtLogin: boolean }
  set(openAtLogin: boolean): void
}

/** Start at login. The OS login item is the source of truth; nothing here caches it. */
export interface Autostart {
  /** False in a repo build: there the login item would register `electron.exe`, not the app. */
  readonly available: boolean
  enabled(): boolean
  set(enabled: boolean): void
}

/**
 * `setLoginItemSettings` registers the running executable. In a repo build that is
 * `node_modules\electron\dist\electron.exe`, so only a packaged build ever touches the login item.
 */
export function createAutostart(packaged: boolean, items: LoginItems): Autostart {
  if (!packaged) {
    return {
      available: false,
      enabled: () => false,
      set: () => undefined,
    }
  }
  return {
    available: true,
    enabled: () => items.get().openAtLogin,
    set: (enabled) => {
      items.set(enabled)
    },
  }
}
