import type { BrowserWindow } from 'electron'

/**
 * Locks a window to the page we load into it. Both windows (the overlay and the setup window) call
 * it. A foreign page would get the same preload, and with the overlay's that means the token, the
 * pending requests and the power to decide them. So navigation started from the renderer, new
 * windows and `<webview>` are refused.
 *
 * The Electron docs say `will-navigate` does not fire for navigation started from code (for example
 * `loadURL`), so our own load and `reload` (also from code) still work. `will-redirect` is left alone
 * on purpose: after a refused navigation there is nothing to redirect, and a redirect of our own load
 * should not break.
 *
 * Neither window needs any permission (camera, notifications, clipboard, fullscreen). The handlers
 * are set on the window's session, which both windows share (the default session).
 */
export function hardenWindow(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  const { session } = window.webContents
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
}
