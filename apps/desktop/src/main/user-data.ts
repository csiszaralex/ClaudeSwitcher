import path from 'node:path'

/**
 * The app's `userData` directory, pinned to the one unpackaged builds have always used.
 *
 * Without a `productName`, Electron names the directory after the package name
 * (`@claudeswitcher/desktop`). The packaged build sets `productName: ClaudeSwitcher`
 * (`electron-builder.yml`), which would move it to `%APPDATA%\ClaudeSwitcher` and leave
 * the token, and with it the installed hooks, behind.
 */
export function userDataDir(appData: string): string {
  return path.join(appData, '@claudeswitcher', 'desktop')
}
