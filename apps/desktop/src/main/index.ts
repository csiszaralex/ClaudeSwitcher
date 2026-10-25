import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWin32ProcessProbe, parseUserDecision, resolveClaudeDir } from '@claudeswitcher/core'
import { startDaemon, type Daemon } from '@claudeswitcher/daemon'
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, screen, shell } from 'electron'
import { configPath, loadConfig, updateConfig } from './config.js'
import { TAB_FOCUS_SETTLE_MS, focusSessionWindow, isFastFocusAvailable, tabFocusUri } from './focus-window.js'
import { registerHotkey } from './hotkey.js'
import { createNativeProcessProbe } from './process-probe.js'
import { DAEMON_PORT, installIntegration, uninstallIntegration } from './setup.js'
import { stopWithin } from './shutdown.js'
import { loadOrCreateToken } from './token.js'
import { createTray } from './tray.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

let daemon: Daemon | undefined
let overlay: BrowserWindow | undefined
/** A gyorsbillentyű és a tálcaikon elengedése kilépéskor; indulás után kap tartalmat. */
let cleanup: () => void = () => undefined
/**
 * Igaz, ha a Windows a munkamenetet zárja (leállítás, újraindítás, kijelentkezés). Ilyenkor a
 * `before-quit` a dokumentáció szerint nem fut le, tehát a `quitting` sem vált; az overlay
 * bezárását ekkor sem szabad visszatartani.
 */
let sessionEnding = false

function createOverlay(): BrowserWindow {
  const window = new BrowserWindow({
    width: 620,
    height: 600,
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

  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'))
  }
  window.on('blur', () => {
    window.hide()
  })
  // Az overlay megjelenésének jele a renderernek: erre jelöli ki a legrégebben várakozó
  // sessiont. Szándékosan a main `show` eseménye, nem a renderer `focus`-a vagy a
  // `visibilitychange`: a Windows előtérzára a `focus()`-t csendben megtagadhatja (lásd
  // session:focus), a Chromium láthatósági jele pedig az ablakelfedés-követéstől függ. A
  // `show` mindig lefut, amikor az ablak ténylegesen láthatóvá válik — és csak akkor.
  window.on('show', () => {
    window.webContents.send('overlay:shown')
  })

  // Az Alt+F4 a keret nélküli ablakot is bezárná, és vele az egyetlen ablakot végleg. Utána a
  // gyorsbillentyű és a tálca egy megsemmisült ablakot érne el („Object has been destroyed"),
  // miközben a hookok tovább élnek. Ezért a bezárás csak elrejt, amíg nem lépünk ki: így a
  // renderer állapota és a WS kapcsolata is megmarad. Kilépéskor a `before-quit` a `quitting`-ot
  // még az ablakok `close` eseménye előtt átállítja, tehát a valódi kilépést ez nem tartja vissza.
  window.on('close', (event) => {
    if (quitting !== 'no' || sessionEnding) return
    event.preventDefault()
    window.hide()
  })
  window.on('session-end', () => {
    sessionEnding = true
  })

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

/** Elrejti az overlayt, ha még létezik. Egy megsemmisült ablak `hide()`-ja dobna. */
function hideOverlay(): void {
  if (overlay !== undefined && !overlay.isDestroyed()) overlay.hide()
}

/**
 * Elküldi a tab-fókusz URI-t a VSCode-nak, `TAB_FOCUS_SETTLE_MS` várakozás után. Soha nem dob:
 * egy elbukott megnyitás csak naplózódik — az ablak ilyenkor is elöl van, mint az M1-ben.
 */
async function openTabFocusUri(uri: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TAB_FOCUS_SETTLE_MS))
  try {
    await shell.openExternal(uri)
  } catch (error) {
    console.error('[focus] could not open the tab focus URI; the window stays focused', error)
  }
}

/**
 * Egyszerre egy példány. Egy második példány a fix porton elbukna (hibadialógussal), és a
 * közös `userData` miatt a Chromium cache-t is összeakasztaná („Unable to move the cache:
 * Access is denied"). Ezért a második példány csendben kilép, még a port lefoglalása és
 * bármilyen ablak előtt; az első a `second-instance` eseményre megmutatja az overlayt.
 */
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  console.log('[claudeswitcher] another instance is already running; quitting')
  app.quit()
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
  // A token tartós, a port rögzített: a telepített hookok és a statusLine ezeket kapják
  // a settings.json-ban, így az app újraindítása után is érvényesek maradnak. Foglalt
  // porton a startDaemon elutasít, és az indulási hibadialógus jelenik meg.
  const userData = app.getPath('userData')
  const config = await loadConfig(userData)
  // Futás közben a tálcapipa állítja; a renderer minden appból hozott döntés után innen kérdezi.
  let hideAfterLastDecision = config.hideAfterLastDecision
  // Ugyanígy: a tálcapipa azonnal átállítja, a következő fókuszkérés már az új értéket látja.
  let jumpToTab = config.jumpToTab
  const token = await loadOrCreateToken(userData)
  // Egy helyi, nem-null konstans: a kezelők ezt fogják be, így nincs szükség `!`-re, és a típus
  // garantálja, hogy indulás után minden kezelő ugyanazt a futó daemont látja. A modulszintű
  // `daemon` csak a `before-quit`-nek kell.
  // A natív probe az elsődleges; a PowerShell csak tartalék, ha a koffi nem tölthető be.
  const nativeProbe = createNativeProcessProbe()
  const running = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: nativeProbe ?? createWin32ProcessProbe(),
    port: DAEMON_PORT,
    token,
  })
  daemon = running
  await running.refresh()

  ipcMain.handle('daemon:connection', () => ({ port: running.port, token: running.token }))
  ipcMain.handle('daemon:state', () => running.state())
  ipcMain.handle('decision:decide', (_event, id: unknown, raw: unknown) => {
    // IPC-bemenet: a renderer bármit küldhet. Csak egy pontosan érvényes döntés jut a
    // daemonhoz — annak érvényességét az adott kérésre a broker még külön ellenőrzi.
    if (typeof id !== 'string') return { ok: false, reason: 'Érvénytelen azonosító.' }
    const decision = parseUserDecision(raw)
    if (decision === undefined) return { ok: false, reason: 'Érvénytelen döntés.' }
    return running.decide(id, decision)
  })

  ipcMain.handle('session:focus', async (_event, sessionId: unknown) => {
    // IPC-bemenet: a renderer bármit küldhet, ezért `unknown`, és itt ellenőrizzük.
    if (typeof sessionId !== 'string') return false
    const view = running.state().sessions.find((s) => s.sessionId === sessionId)
    if (view === undefined) return false
    // Előbb fókuszálunk, csak utána rejtjük el az overlayt. A Windows csak annak a
    // folyamatnak engedi a SetForegroundWindow-t, amelyik épp az előtérben van —
    // az overlay elrejtése ezt a jogot elvenné tőlünk, és a hívás csendben csak a
    // tálcagombot villogtatná. Ha így is elbukik, a `code -r` tartalék megoldja.
    const outcome = await focusSessionWindow(view)
    hideOverlay()
    // A pontos tab csak az ablak UTÁN, és csak ha a `tabFocusUri` minden feltétele teljesül.
    // A döntéseket a fókusz UTÁN olvassuk: a várakozás alatt egy fájlírás-kérés is beérkezhetett.
    // Nem várjuk meg: a renderer az ablakfókusz eredményét kapja, ugyanúgy, mint eddig.
    const uri = tabFocusUri(view, outcome, jumpToTab, running.state().decisions)
    if (uri !== undefined) void openTabFocusUri(uri)
    return outcome !== 'failed'
  })

  ipcMain.handle('overlay:hide', () => {
    hideOverlay()
  })

  ipcMain.handle('settings:get', () => ({ hideAfterLastDecision }))

  // Indulási összegzés a főprocessz stdoutjára. Ez teszi a Step 5 ellenőrzését
  // automatizálhatóvá: nem kell DevTools-konzolba gépelni ahhoz, hogy lássuk,
  // a daemon elindult és tényleg megtalálta a futó sessionöket.
  console.log(
    `[claudeswitcher] daemon on 127.0.0.1:${running.port}, ` +
      `${running.state().sessions.length} session(s) discovered, ` +
      `fast focus ${isFastFocusAvailable() ? 'available' : 'UNAVAILABLE'}, ` +
      `process probe ${nativeProbe === undefined ? 'PowerShell (fallback)' : 'native'}`,
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
    hideAfterLastDecision,
    onToggleHideAfterLastDecision: (enabled) => {
      // Azonnal él, akkor is, ha a mentés elbukik (pl. elrontott config fájl) — akkor csak
      // ennek a futásnak a végéig.
      hideAfterLastDecision = enabled
      void updateConfig(userData, { hideAfterLastDecision: enabled })
    },
    jumpToTab,
    onToggleJumpToTab: (enabled) => {
      jumpToTab = enabled
      void updateConfig(userData, { jumpToTab: enabled })
    },
    onOpen: () => {
      showOverlay()
    },
    onQuit: () => {
      app.quit()
    },
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
    // Kilépés közben nem hozunk létre új ablakot, és nem mutatjuk a régit.
    if (quitting !== 'no') return
    // A `close` kezelő óta az overlay csak kilépéskor semmisül meg. Ha mégis megsemmisült (egy
    // ismeretlen út), egy új ablak jobb, mint egy „Object has been destroyed" kivétel.
    if (overlay === undefined || overlay.isDestroyed()) overlay = createOverlay()
    const window = overlay
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    // getBounds(), nem getSize(): az Electron a getSize()-t `number[]`-ként típusozza,
    // amiből `noUncheckedIndexedAccess` mellett csak típus-kényszerítéssel lehetne
    // szélességet és magasságot kivenni. A getBounds() elnevezett mezőket ad.
    const { width, height } = window.getBounds()
    window.setPosition(
      Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      Math.round(display.workArea.y + (display.workArea.height - height) / 3),
    )
    window.show()
    window.focus()
  }

  function toggleOverlay(): void {
    if (overlay !== undefined && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide()
    else showOverlay()
  }

  // Egy második indítás (pl. a parancsikonra kattintva) a futó példányt hozza elő.
  app.on('second-instance', () => {
    showOverlay()
  })

  // A tálca és a gyorsbillentyű állapota a stdoutra. Ez teszi a Task 13 ellenőrzését
  // gomblenyomás nélkül mérhetővé: a createTray üres ikonnál dob, tehát ha ez a sor
  // megjelenik, a tálcaikon látható képet kapott.
  console.log(
    `[claudeswitcher] tray ready, hotkey ${config.hotkey} ` +
      (hotkeyRegistered ? 'registered' : 'NOT registered (taken by another application)'),
  )

  const syncTray = (): void => {
    tray.setWaiting(running.state().sessions.filter((s) => s.status === 'waiting').length)
  }
  syncTray()
  setInterval(syncTray, 1000).unref()

  // A kilépéskori takarítás a lenti, egyetlen `before-quit` kezelőé — az fut le pontosan egyszer.
  cleanup = () => {
    globalShortcut.unregisterAll()
    tray.destroy()
  }
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

/**
 * Kilépés: az Electron nem várja meg az aszinkron `stop()`-ot, így a tartott kérések üres 200-ai
 * kimenet nélkül halhatnának el. Ezért az első `before-quit`-et megállítjuk, legfeljebb
 * STOP_TIMEOUT_MS-ig várunk a daemonra, aztán valóban kilépünk. A második `before-quit` (a saját
 * `app.quit()`-ünké, vagy egy türelmetlen második kérés) már nem indít újabb leállást.
 */
let quitting: 'no' | 'stopping' | 'done' = 'no'
app.on('before-quit', (event) => {
  if (quitting === 'done') return
  event.preventDefault()
  if (quitting === 'stopping') return
  quitting = 'stopping'
  // Egy takarítási hiba ne akassza meg a kilépést: a daemon leállása és a quit ettől még fut.
  try {
    cleanup()
  } catch (error) {
    console.error('[claudeswitcher] cleanup failed', error)
  }
  const running = daemon
  const stopped = running === undefined ? Promise.resolve(true) : stopWithin(() => running.stop())
  void stopped.then((inTime) => {
    if (!inTime) console.error('[claudeswitcher] daemon did not stop in time; quitting anyway')
    quitting = 'done'
    app.quit()
  })
})
