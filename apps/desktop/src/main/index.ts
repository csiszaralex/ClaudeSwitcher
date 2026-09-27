import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWin32ProcessProbe, resolveClaudeDir } from '@claudeswitcher/core'
import { startDaemon, type Daemon } from '@claudeswitcher/daemon'
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, screen, shell } from 'electron'
import { configPath, loadConfig } from './config.js'
import { focusSessionWindow, isFastFocusAvailable } from './focus-window.js'
import { registerHotkey } from './hotkey.js'
import { DAEMON_PORT, installIntegration, uninstallIntegration } from './setup.js'
import { loadOrCreateToken } from './token.js'
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

  // Ha a renderer processz meghal (OOM, GPU- vagy V8-összeomlás), az Electron egy üres
  // keretet hagy, és semmi nem tölti újra. Az overlay az egyetlen ablak, tehát a
  // gyorsbillentyű onnantól egy üres ablakot mutatna — ami pont úgy néz ki, mint a „nincs
  // futó session", vagyis a monitorozó eszköz a legrosszabb módon hibázna: csendben.
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[claudeswitcher] renderer gone (${details.reason}); reloading`)
    if (!window.isDestroyed()) window.reload()
  })

  return window
}

app.whenReady().then(async () => {
  // A token tartós, a port rögzített: a telepített hookok és a statusLine ezeket kapják
  // a settings.json-ban, így az app újraindítása után is érvényesek maradnak. Foglalt
  // porton a startDaemon elutasít, és az indulási hibadialógus jelenik meg.
  const userData = app.getPath('userData')
  const config = await loadConfig(userData)
  const token = await loadOrCreateToken(userData)
  daemon = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: createWin32ProcessProbe(),
    port: DAEMON_PORT,
    token,
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

  // Csak fejlesztői build: abszolút útvonal ennek a repónak a lefordított statusline
  // scriptjére. Ha a repó elköltözik vagy a dist törlődik, újra kell telepíteni.
  const statusLineScript = path.join(dirname, '../../../../packages/statusline/dist/main.js')
  const statusLineCommand = `node "${statusLineScript}"`

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  // A gyorsbillentyűt a tálca ELŐTT foglaljuk le, mert a menü megjeleníti az eredményt.
  // A showOverlay/toggleOverlay függvénydeklarációk, tehát hoistolódnak — a lentebbi
  // definíciójuk ekkor már hívható.
  const hotkeyRegistered = registerHotkey(config.hotkey, toggleOverlay)

  const tray = createTray({
    hotkey: { accelerator: config.hotkey, registered: hotkeyRegistered },
    // A config fájl megnyitása a rendszer szerkesztőjével. Enélkül az „állítható"
    // gyakorlatban azt jelentené, hogy a felhasználónak ki kell találnia egy útvonalat az
    // AppData alatt.
    onEditHotkey: () => {
      void shell.openPath(configPath(userData))
    },
    onOpen: () => showOverlay(),
    onQuit: () => app.quit(),
    onInstall: () => {
      // A telepítés különben „sikerült"-et jelentene egy olyan status line-ra, ami nem
      // létezik — a limitek egyszerűen nem jelennének meg, ok nélkül. Lefordítatlan
      // `dist`-nél ez a leggyakoribb eset, ezért ütközésként mondjuk meg.
      const missingStatusLine = existsSync(statusLineScript)
        ? []
        : [
            `A status line scriptje nincs meg (${statusLineScript}). ` +
              'Futtass egy `pnpm build`-et a repo gyökerében, majd telepíts újra — ' +
              'addig a limitek nem jelennek meg.',
          ]

      installIntegration(resolveClaudeDir(), { port: DAEMON_PORT, token, statusLineCommand })
        .then((installConflicts) => {
          const conflicts = [...missingStatusLine, ...installConflicts]
          void dialog.showMessageBox({
            type: conflicts.length === 0 ? 'info' : 'warning',
            title: 'ClaudeSwitcher',
            message:
              conflicts.length === 0
                ? 'A Claude Code integráció telepítve.'
                : 'A Claude Code integráció csak részben települt.',
            detail: [
              ...conflicts,
              'Az újonnan indított Claude Code sessionök már jelentenek. A már futó sessionöket lehet, hogy újra kell indítani.',
            ].join('\n\n'),
          })
        })
        .catch((error: unknown) => {
          dialog.showErrorBox('A telepítés nem sikerült', describeError(error))
        })
    },
    onUninstall: () => {
      uninstallIntegration(resolveClaudeDir())
        .then(() => {
          void dialog.showMessageBox({
            type: 'info',
            title: 'ClaudeSwitcher',
            message: 'A Claude Code integráció eltávolítva.',
          })
        })
        .catch((error: unknown) => {
          dialog.showErrorBox('Az eltávolítás nem sikerült', describeError(error))
        })
    },
  })

  function showOverlay(): void {
    if (overlay === undefined) return
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    // getBounds(), nem getSize(): az Electron a getSize()-t `number[]`-ként típusozza,
    // amiből `noUncheckedIndexedAccess` mellett csak típus-kényszerítéssel lehetne
    // szélességet és magasságot kivenni. A getBounds() elnevezett mezőket ad.
    const { width, height } = overlay.getBounds()
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

  // A tálca és a gyorsbillentyű állapota a stdoutra. Ez teszi a Task 13 ellenőrzését
  // gomblenyomás nélkül mérhetővé: a createTray üres ikonnál dob, tehát ha ez a sor
  // megjelenik, a tálcaikon látható képet kapott.
  console.log(
    `[claudeswitcher] tray ready, hotkey ${config.hotkey} ` +
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
