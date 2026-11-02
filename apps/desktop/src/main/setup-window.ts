import { BrowserWindow } from 'electron'
import { SETUP_CHANNELS } from '../shared/setup-channels.js'
import { hardenWindow } from './harden-window.js'
import { captureStep } from './hotkey-capture.js'
import type { RendererLocation } from './ipc-sender.js'

/** Content size of the setup window: all four settings, the integration row and the button fit. */
const SETUP_WIDTH = 480
const SETUP_HEIGHT = 520

export interface SetupWindowController {
  /**
   * Opens the window, or brings the open one to the front. `showAll` (the tray's "Beállítások…")
   * also widens a window that was opened for the first run.
   */
  open(options: { showAll: boolean }): void
  /** Whether the open window shows every setting; what `setup:load` reports. */
  showAll(): boolean
  /** Tells an open window to reload its state (`setup:changed`). */
  notifyChanged(): void
  /** Sends a capture's result to an open window (`setup:captured`). */
  sendCaptured(payload: CapturedPayload): void
}

/** The `setup:captured` payload; the renderer reads it with `readCaptured`. */
type CapturedPayload = { accelerator: string } | { cancelled: true }

/** The hotkey capture as the window sees it (`HotkeyController`: `capturing` and `endCapture`). */
export interface WindowCapture {
  active(): boolean
  /** Ends the capture and registers the held hotkey again. Does nothing when none is active. */
  end(): void
}

/**
 * Brings a window to the front. On Windows a plain `show()` + `focus()` from an app started in the
 * background (autostart, a start from the tray) is often refused by the foreground lock: the window
 * opens behind the others, and the user never sees the first-run window. Briefly making it
 * always-on-top lifts it above the other windows even when the focus is refused; `moveTop` puts it
 * at the top of the z-order. It is not left always on top.
 */
function bringToFront(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.show()
  window.setAlwaysOnTop(true)
  window.focus()
  window.moveTop()
  window.setAlwaysOnTop(false)
}

/**
 * The one setup window. Unlike the overlay it is a normal framed window: not always on top, in
 * the taskbar, and closing it really closes it (which confirms nothing). It gets its own preload,
 * `setup.cjs`, which exposes only `SetupApi`, never the daemon token.
 */
export function createSetupWindowController(options: {
  page: RendererLocation
  preload: string
  capture: WindowCapture
}): SetupWindowController {
  let window: BrowserWindow | undefined
  let showAll = false

  const isOpen = (current: BrowserWindow | undefined): current is BrowserWindow =>
    current !== undefined && !current.isDestroyed()

  const notifyChanged = (): void => {
    if (isOpen(window)) window.webContents.send(SETUP_CHANNELS.changed)
  }
  const sendCaptured = (payload: CapturedPayload): void => {
    if (isOpen(window)) window.webContents.send(SETUP_CHANNELS.captured, payload)
  }

  const create = (): BrowserWindow => {
    const created = new BrowserWindow({
      width: SETUP_WIDTH,
      height: SETUP_HEIGHT,
      useContentSize: true,
      minWidth: 380,
      minHeight: 300,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // No `title` here: the page's `<title>` in `setup.html` names the window.
      // Also in `styles.css` (`body` background), and needed here too: this colour shows before the
      // page has painted, so the window does not flash white. Keep the two the same.
      backgroundColor: '#1c1b1a',
      webPreferences: {
        preload: options.preload,
        // The same explicit security settings as the overlay (see `createOverlay`).
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    // A framed window gets Electron's default menu bar (File, Edit, …); this page has no use for it.
    created.removeMenu()
    hardenWindow(created)
    created.once('ready-to-show', () => {
      bringToFront(created)
    })

    // While capturing, the main process reads the keys, not the page. `preventDefault` keeps the key
    // from the page and from menu shortcuts (Electron docs, `before-input-event`). The Alt+Space
    // family never gets here: Windows takes it for the system menu first, so it is captured through
    // temporary global shortcuts instead (`CAPTURE_SHORTCUTS`).
    created.webContents.on('before-input-event', (event, input) => {
      if (!options.capture.active()) return
      event.preventDefault()
      const step = captureStep(input)
      if (step.kind === 'ignore') return
      options.capture.end()
      sendCaptured(step.kind === 'captured' ? { accelerator: step.accelerator } : { cancelled: true })
    })
    created.on('blur', () => {
      if (!options.capture.active()) return
      options.capture.end()
      sendCaptured({ cancelled: true })
    })
    created.on('closed', () => {
      options.capture.end()
      if (window === created) window = undefined
    })
    if (options.page.kind === 'dev-server') {
      void created.loadURL(options.page.url)
    } else {
      void created.loadFile(options.page.path)
    }
    return created
  }

  return {
    open(request) {
      if (isOpen(window)) {
        if (request.showAll && !showAll) {
          showAll = true
          notifyChanged()
        }
        bringToFront(window)
        return
      }
      showAll = request.showAll
      window = create()
    },
    showAll: () => showAll,
    notifyChanged,
    sendCaptured,
  }
}
