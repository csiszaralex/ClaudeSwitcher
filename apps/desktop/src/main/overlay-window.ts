import { BrowserWindow, screen } from 'electron'
import { OVERLAY_CHANNELS } from '../shared/overlay-channels.js'
import { hardenWindow, loadPage, secureWebPreferences } from './harden-window.js'
import type { RendererLocation } from './ipc-sender.js'
import { OVERLAY_HEIGHT, OVERLAY_WIDTH, overlayBounds } from './overlay-placement.js'
import { RELOAD_LIMIT, RELOAD_WINDOW_MS, createReloadLimiter } from './reload-limit.js'

/**
 * The overlay window: the frameless, always-on-top window the hotkey and the tray bring up. Every
 * member is a function property, so it can be passed on unbound.
 */
export interface OverlayController {
  /** Shows the overlay on the cursor's display. Does nothing while quitting. */
  readonly show: () => void
  /** Hides a visible overlay, otherwise shows it (`show`). */
  readonly toggle: () => void
  /** Hides the overlay if it still exists. */
  readonly hide: () => void
}

/**
 * Creates the overlay window at once, and re-creates it from `show` if it was destroyed.
 * `isQuitting` is read on every call (the window's `close` and `show`), never captured.
 */
export function createOverlayController(options: {
  page: RendererLocation
  preload: string
  isQuitting: () => boolean
}): OverlayController {
  /**
   * True when Windows ends the session (shutdown, restart, sign-out). Electron's documentation says
   * `before-quit` does not run then, so `isQuitting()` stays false; the overlay's close must not be
   * held back in that case either.
   */
  let sessionEnding = false
  /** The limit on the overlay's renderer reloads, shared across a re-created overlay too. */
  const allowRendererReload = createReloadLimiter()

  function createOverlay(): BrowserWindow {
    const window = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: secureWebPreferences(options.preload),
    })

    // Only our own page may load in it (see `hardenWindow`).
    hardenWindow(window)

    loadPage(window, options.page)
    window.on('blur', () => {
      window.hide()
    })
    // The signal to the renderer that the overlay appeared: on it the renderer selects the session
    // that has been waiting longest. Deliberately the main process's `show` event, not the
    // renderer's `focus` or `visibilitychange`: the Windows foreground lock can silently refuse
    // `focus()` (see `bringToFront`), and Chromium's visibility signal depends on window occlusion
    // tracking. `show` always fires when the window really becomes visible, and only then.
    window.on('show', () => {
      window.webContents.send(OVERLAY_CHANNELS.shown)
    })

    // Alt+F4 would close the frameless window too, and with it the only window for good. After that
    // the hotkey and the tray would reach a destroyed window ("Object has been destroyed") while the
    // hooks live on. So a close only hides until the app quits: this way the renderer's state and
    // its WS connection are kept too.
    // On quit, `before-quit` starts the quit sequence before the windows' `close` events, so
    // `isQuitting()` is already true here and a real quit is not held back.
    window.on('close', (event) => {
      if (options.isQuitting() || sessionEnding) return
      event.preventDefault()
      window.hide()
    })
    window.on('session-end', () => {
      sessionEnding = true
    })

    // If the renderer process dies (out of memory, a GPU or V8 crash), Electron leaves an empty
    // frame and nothing reloads it. The overlay is the only window, so from then on the hotkey would
    // show an empty window that looks exactly like "no session running": the monitoring tool would
    // fail in the worst way, silently. The reload is limited: a renderer that always crashes on load
    // would otherwise loop for ever. Past the limit, the next opening of the overlay tries again
    // (`show`).
    window.webContents.on('render-process-gone', (_event, details) => {
      if (window.isDestroyed()) return
      if (allowRendererReload()) {
        console.error(`[claudeswitcher] renderer gone (${details.reason}); reloading`)
        window.reload()
      } else {
        console.error(
          `[claudeswitcher] renderer gone (${details.reason}) after ${RELOAD_LIMIT} reloads ` +
            `within ${RELOAD_WINDOW_MS / 1000} s; not reloading until the overlay is opened again`,
        )
      }
    })

    return window
  }

  let overlay = createOverlay()

  const show = (): void => {
    // While quitting, no new window is created and the old one is not shown.
    if (options.isQuitting()) return
    // Since the `close` handler, the overlay is destroyed only on quit. If it was destroyed anyway
    // (by an unknown path), a new window is better than an "Object has been destroyed" exception.
    if (overlay.isDestroyed()) overlay = createOverlay()
    const window = overlay
    // If the renderer stayed dead because of the limit, opening retries (also within the limit).
    if (window.webContents.isCrashed() && allowRendererReload()) window.reload()
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    // Position and size with a single `setBounds`, clamped to the work area. So the top of the
    // overlay does not stick out on a low display either; a `setPosition` that only sets the
    // position can break the size too between displays with different scaling.
    window.setBounds(overlayBounds(display.workArea))
    window.show()
    window.focus()
  }

  return {
    show,
    toggle: () => {
      if (!overlay.isDestroyed() && overlay.isVisible()) overlay.hide()
      else show()
    },
    // `hide()` on a destroyed window would throw.
    hide: () => {
      if (!overlay.isDestroyed()) overlay.hide()
    },
  }
}
