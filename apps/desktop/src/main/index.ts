import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWin32ProcessProbe, resolveClaudeDir } from '@claudeswitcher/core'
import { startDaemon, type Daemon } from '@claudeswitcher/daemon'
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, screen } from 'electron'
import { focusSessionWindow, isFastFocusAvailable } from './focus-window.js'
import { OVERLAY_HOTKEY, registerHotkey } from './hotkey.js'
import { createTray } from './tray.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

let daemon: Daemon | undefined
let overlay: BrowserWindow | undefined

function createOverlay(): BrowserWindow {
  const window = new BrowserWindow({
    width: 620,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(dirname, '../preload/index.js'),
      // Ezek az Electron 33 alapértelmezései. Szándékosan kiírjuk őket: így a
      // biztonsági állás önmagát dokumentálja, és egy jövőbeli Electron-verzió
      // megváltozott alapértéke sem tudja csendben meggyengíteni. A preload csak
      // contextBridge-et és ipcRenderer-t használ, ami sandboxban is működik.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'))
  }
  window.on('blur', () => window.hide())
  return window
}

app.whenReady().then(async () => {
  daemon = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: createWin32ProcessProbe(),
  })
  await daemon.refresh()

  ipcMain.handle('daemon:connection', () => ({ port: daemon!.port, token: daemon!.token }))
  ipcMain.handle('daemon:state', () => daemon!.state())

  ipcMain.handle('session:focus', async (_event, sessionId: string) => {
    const view = daemon!.state().sessions.find((s) => s.sessionId === sessionId)
    if (view === undefined) return false
    // Előbb fókuszálunk, csak utána rejtjük el az overlayt. A Windows csak annak a
    // folyamatnak engedi a SetForegroundWindow-t, amelyik épp az előtérben van —
    // az overlay elrejtése ezt a jogot elvenné tőlünk, és a hívás csendben csak a
    // tálcagombot villogtatná. Ha így is elbukik, a `code -r` tartalék megoldja.
    const focused = await focusSessionWindow(view)
    overlay?.hide()
    return focused
  })

  ipcMain.handle('overlay:hide', () => {
    overlay?.hide()
  })

  // Indulási összegzés a főprocessz stdoutjára. Ez teszi a Step 5 ellenőrzését
  // automatizálhatóvá: nem kell DevTools-konzolba gépelni ahhoz, hogy lássuk,
  // a daemon elindult és tényleg megtalálta a futó sessionöket.
  console.log(
    `[claudeswitcher] daemon on 127.0.0.1:${daemon.port}, ` +
      `${daemon.state().sessions.length} session(s) discovered, ` +
      `fast focus ${isFastFocusAvailable() ? 'available' : 'UNAVAILABLE'}`,
  )

  overlay = createOverlay()

  const tray = createTray({
    onOpen: () => showOverlay(),
    onQuit: () => app.quit(),
  })

  function showOverlay(): void {
    if (overlay === undefined) return
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const [width, height] = overlay.getSize() as [number, number]
    overlay.setPosition(
      Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      Math.round(display.workArea.y + (display.workArea.height - height) / 3),
    )
    overlay.show()
    overlay.focus()
  }

  function toggleOverlay(): void {
    if (overlay?.isVisible() === true) overlay.hide()
    else showOverlay()
  }

  const hotkeyRegistered = registerHotkey(OVERLAY_HOTKEY, toggleOverlay)

  // A tálca és a gyorsbillentyű állapota a stdoutra. Ez teszi a Task 13 ellenőrzését
  // gomblenyomás nélkül mérhetővé: a createTray üres ikonnál dob, tehát ha ez a sor
  // megjelenik, a tálcaikon látható képet kapott.
  console.log(
    `[claudeswitcher] tray ready, hotkey ${OVERLAY_HOTKEY} ` +
      (hotkeyRegistered ? 'registered' : 'NOT registered (taken by another application)'),
  )

  const syncTray = (): void => {
    tray.setWaiting(daemon!.state().sessions.filter((s) => s.status === 'waiting').length)
  }
  syncTray()
  setInterval(syncTray, 1000).unref()

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    tray.destroy()
  })
}).catch((error: unknown) => {
  // Tálcaikonos app: ha az indulás elbukik — tipikusan a daemon —, nincs ablak és
  // nincs tálcaikon, a processz csendben halott maradna, a felhasználó pedig csak
  // azt látná, hogy „nem csinál semmit". A showErrorBox szinkron és ablak nélkül
  // is működik, tehát ez az egyetlen hely, ahol a hiba biztosan eljut hozzá.
  console.error('[claudeswitcher] startup failed', error)
  dialog.showErrorBox(
    'A ClaudeSwitcher nem tudott elindulni',
    error instanceof Error ? error.message : String(error),
  )
  app.quit()
})

app.on('window-all-closed', () => {
  // Tálcaikonos app: az ablak bezárása nem lépteti ki.
})

app.on('before-quit', () => {
  void daemon?.stop()
})
