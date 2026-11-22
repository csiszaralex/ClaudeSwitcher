import { BrowserWindow, screen } from 'electron'
import { OVERLAY_CHANNELS } from '../shared/overlay-channels.js'
import type { FocusReturn } from './focus-return.js'
import { hardenWindow, loadPage, secureWebPreferences } from './harden-window.js'
import type { RendererLocation } from './ipc-sender.js'
import { OVERLAY_HEIGHT, OVERLAY_WIDTH, overlayBounds } from './overlay-placement.js'
import { RELOAD_LIMIT, RELOAD_WINDOW_MS, createReloadLimiter } from './reload-limit.js'

/**
 * The overlay window: the frameless, always-on-top window the hotkey and the tray bring up. Every
 * member is a function property, so it can be passed on unbound.
 */
export interface OverlayController {
  /**
   * Shows the overlay on the cursor's display. Does nothing while quitting. With `selectSessionId`
   * the list opens on that session (a notification was clicked), otherwise on the one waiting
   * longest. Its parameter is optional, so it still fits `() => void` where it is passed on.
   */
  readonly show: (selectSessionId?: string) => void
  /** Dismisses a visible overlay (`dismiss`), otherwise shows it (`show`). The hotkey calls it. */
  readonly toggle: () => void
  /**
   * Hides the overlay if it still exists, and gives the focus to nothing. For the jump (`main/index.ts`
   * `focusSession`), which has just brought up the session's window on purpose.
   */
  readonly hide: () => void
  /**
   * Hides a visible overlay the user dismissed (Esc, the hide after the last decision, the hotkey
   * again), giving the focus back to the window that was in front when it opened (`FocusReturn`).
   */
  readonly dismiss: () => Promise<void>
  /** Whether the overlay is visible now. */
  readonly isVisible: () => boolean
  /** Registers a listener for the overlay being hidden (its window's `hide` event, a re-created window included). */
  readonly onHidden: (listener: () => void) => void
  /** Pushes a message to the overlay's page on `channel` (visible or not); nothing once its window is destroyed. */
  readonly send: (channel: string, payload: unknown) => void
}

/**
 * Creates the overlay window at once, and re-creates it from `show` if it was destroyed.
 * `isQuitting` is read on every call (the window's `close` and `show`), never captured.
 */
export function createOverlayController(options: {
  page: RendererLocation
  preload: string
  isQuitting: () => boolean
  /** Remembers the foreground window on opening and gives the focus back on `dismiss`. */
  focusReturn: FocusReturn
}): OverlayController {
  /**
   * True when Windows ends the session (shutdown, restart, sign-out). Electron's documentation says
   * `before-quit` does not run then, so `isQuitting()` stays false; the overlay's close must not be
   * held back in that case either.
   */
  let sessionEnding = false
  /** The limit on the overlay's renderer reloads, shared across a re-created overlay too. */
  const allowRendererReload = createReloadLimiter()
  /** The `onHidden` listeners; every window `createOverlay` makes calls them. */
  const hiddenListeners: (() => void)[] = []
  /** The session to select on the next `shown` signal; `show` sets it, the window's `show` event sends and clears it. */
  let preferredSessionId: string | undefined

  /** The `shown` signal, with the preferred session when there is one (the renderer reads it with a check). */
  function sendShown(window: BrowserWindow): void {
    const preferred = preferredSessionId
    preferredSessionId = undefined
    if (preferred === undefined) window.webContents.send(OVERLAY_CHANNELS.shown)
    else window.webContents.send(OVERLAY_CHANNELS.shown, preferred)
  }

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
      sendShown(window)
    })
    window.on('hide', () => {
      for (const listener of hiddenListeners) listener()
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

  const show = (selectSessionId?: string): void => {
    // While quitting, no new window is created and the old one is not shown.
    if (options.isQuitting()) return
    // Since the `close` handler, the overlay is destroyed only on quit. If it was destroyed anyway
    // (by an unknown path), a new window is better than an "Object has been destroyed" exception.
    if (overlay.isDestroyed()) overlay = createOverlay()
    const window = overlay
    // A window that is visible already fires no `show` event again, so the signal goes out here.
    const alreadyVisible = window.isVisible()
    preferredSessionId = selectSessionId
    // If the renderer stayed dead because of the limit, opening retries (also within the limit).
    if (window.webContents.isCrashed() && allowRendererReload()) window.reload()
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    // Position and size with a single `setBounds`, clamped to the work area. So the top of the
    // overlay does not stick out on a low display either; a `setPosition` that only sets the
    // position can break the size too between displays with different scaling.
    window.setBounds(overlayBounds(display.workArea))
    // Before `show` and `focus`: after them the overlay is the foreground window. A visible overlay
    // keeps the window it remembered when it opened.
    if (!alreadyVisible) options.focusReturn.remember()
    window.show()
    window.focus()
    if (alreadyVisible) sendShown(window)
  }

  // `hide()` on a destroyed window would throw.
  const hide = (): void => {
    if (!overlay.isDestroyed()) overlay.hide()
  }

  const dismiss = async (): Promise<void> => {
    if (overlay.isDestroyed() || !overlay.isVisible()) return
    await options.focusReturn.dismiss(overlay.isFocused(), hide)
  }

  return {
    show,
    toggle: () => {
      if (!overlay.isDestroyed() && overlay.isVisible()) void dismiss()
      else show()
    },
    hide,
    dismiss,
    isVisible: () => !overlay.isDestroyed() && overlay.isVisible(),
    onHidden: (listener) => {
      hiddenListeners.push(listener)
    },
    send: (channel, payload) => {
      if (!overlay.isDestroyed()) overlay.webContents.send(channel, payload)
    },
  }
}
