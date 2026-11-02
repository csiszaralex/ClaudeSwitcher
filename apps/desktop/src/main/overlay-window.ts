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
  /** Az overlay renderer-újratöltéseinek korlátja, az újra létrehozott overlayen át is közös. */
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
    // Az overlay megjelenésének jele a renderernek: erre jelöli ki a legrégebben várakozó
    // sessiont. Szándékosan a main `show` eseménye, nem a renderer `focus`-a vagy a
    // `visibilitychange`: a Windows előtérzára a `focus()`-t csendben megtagadhatja (lásd
    // session:focus), a Chromium láthatósági jele pedig az ablakelfedés-követéstől függ. A
    // `show` mindig lefut, amikor az ablak ténylegesen láthatóvá válik, és csak akkor.
    window.on('show', () => {
      window.webContents.send(OVERLAY_CHANNELS.shown)
    })

    // Az Alt+F4 a keret nélküli ablakot is bezárná, és vele az egyetlen ablakot végleg. Utána a
    // gyorsbillentyű és a tálca egy megsemmisült ablakot érne el („Object has been destroyed"),
    // miközben a hookok tovább élnek. Ezért a bezárás csak elrejt, amíg nem lépünk ki: így a
    // renderer állapota és a WS kapcsolata is megmarad.
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
    // Kilépés közben nem hozunk létre új ablakot, és nem mutatjuk a régit.
    if (options.isQuitting()) return
    // A `close` kezelő óta az overlay csak kilépéskor semmisül meg. Ha mégis megsemmisült (egy
    // ismeretlen út), egy új ablak jobb, mint egy „Object has been destroyed" kivétel.
    if (overlay.isDestroyed()) overlay = createOverlay()
    const window = overlay
    // Ha a renderer a korlát miatt halott maradt, a megnyitás próbálja újra (szintén korlátosan).
    if (window.webContents.isCrashed() && allowRendererReload()) window.reload()
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    // Hely és méret egyetlen `setBounds`-szal, a munkaterülethez szorítva. Egy alacsony
    // kijelzőn így az overlay teteje sem lóg ki; a csak pozíciót állító `setPosition` eltérő
    // méretezésű kijelzők között a méretet is elronthatja.
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
