import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWin32ProcessProbe, parseUserDecision, resolveClaudeDir } from '@claudeswitcher/core'
import { startDaemon, type Daemon } from '@claudeswitcher/daemon'
import {
  BrowserWindow,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { configPath, loadConfig, updateConfig } from './config.js'
import { TAB_FOCUS_SETTLE_MS, focusSessionWindow, isFastFocusAvailable, tabFocusUri } from './focus-window.js'
import { hotkeyLogText, registerHotkeyOrDefault } from './hotkey.js'
import { isOverlaySender, rendererLocation } from './ipc-sender.js'
import { OVERLAY_HEIGHT, OVERLAY_WIDTH, overlayBounds } from './overlay-placement.js'
import { createNativeProcessProbe } from './process-probe.js'
import { RELOAD_LIMIT, RELOAD_WINDOW_MS, createReloadLimiter } from './reload-limit.js'
import {
  DAEMON_PORT,
  installIntegration,
  integrationNotice,
  readHookInstallState,
  uninstallIntegration,
} from './setup.js'
import { stopWithin } from './shutdown.js'
import { loadOrCreateToken } from './token.js'
import { createTray } from './tray.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/** Honnan tölt az overlay; az IPC-kezelők a küldőt is ehhez mérik (`fromOverlay`). */
const RENDERER = rendererLocation(process.env['ELECTRON_RENDERER_URL'], path.join(dirname, '../renderer/index.html'))

/**
 * Igaz, ha az IPC-hívás a saját rendererünktől jött (lásd `isOverlaySender`). Egy idegen küldőt
 * naplózunk: ha a saját rendererünk URL-je valamiért eltérne, enélkül csak egy néma, üres overlay
 * látszana.
 */
function fromOverlay(event: IpcMainInvokeEvent, channel: string): boolean {
  const url = event.senderFrame?.url
  if (isOverlaySender(url, RENDERER)) return true
  console.error(`[claudeswitcher] refused ${channel} from a foreign sender: ${url ?? '(no frame)'}`)
  return false
}

/** Az idegen küldőnek adott ok, a hibát jelző válaszokban és a dobott hibában is. */
const FOREIGN_SENDER = 'Ismeretlen küldő.'

/** Az idegen küldő elutasítása azoknál a kezelőknél, amelyeknek nincs hibát jelző válaszuk. */
function foreignSender(): Error {
  return new Error(FOREIGN_SENDER)
}

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

  // Az overlay csak a saját rendererét mutathatja. Egy idegen oldal ugyanazt a preloadot kapná
  // (token, függő kérések, döntés), ezért a renderer felől indított navigáció, az új ablak és a
  // <webview> tiltott. Az Electron-dokumentáció szerint a `will-navigate` a programból indított
  // navigációra (például `loadURL`) nem fut le, így a saját betöltésünket és a `reload`-ot (az is
  // programból indul) nem zárja ki. A `will-redirect`-et szándékosan nem tiltjuk: tiltott navigáció
  // után nincs mit átirányítani, a saját betöltésünk átirányítását pedig nem akarjuk elrontani.
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  // Az overlaynek semmilyen engedély nem kell (kamera, értesítés, vágólap, teljes képernyő).
  const { session } = window.webContents
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)

  if (RENDERER.kind === 'dev-server') {
    void window.loadURL(RENDERER.url)
  } else {
    void window.loadFile(RENDERER.path)
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
  // gyorsbillentyű onnantól egy üres ablakot mutatna, ami pont úgy néz ki, mint a „nincs
  // futó session", vagyis a monitorozó eszköz a legrosszabb módon hibázna: csendben.
  // Az újratöltés korlátos: egy betöltéskor mindig összeomló renderer különben végtelen
  // ciklusba esne. A korlát után az overlay következő megnyitása próbálja újra (`showOverlay`).
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
  // A token tartós, a port rögzített: a telepített hookok ezeket kapják
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

  // Minden kezelő előbb a küldőt nézi (`fromOverlay`). Ahol a válasznak van hibát jelző alakja, azt
  // kapja az idegen küldő; a többi kezelő dob, ami a rendererben elutasított ígéret.
  ipcMain.handle('daemon:connection', (event) => {
    if (!fromOverlay(event, 'daemon:connection')) throw foreignSender()
    return { port: running.port, token: running.token }
  })
  ipcMain.handle('daemon:state', (event) => {
    if (!fromOverlay(event, 'daemon:state')) throw foreignSender()
    return running.state()
  })
  ipcMain.handle('decision:decide', (event, id: unknown, raw: unknown) => {
    if (!fromOverlay(event, 'decision:decide')) return { ok: false, reason: FOREIGN_SENDER }
    // IPC-bemenet: a renderer bármit küldhet. Csak egy pontosan érvényes döntés jut a
    // daemonhoz — annak érvényességét az adott kérésre a broker még külön ellenőrzi.
    if (typeof id !== 'string') return { ok: false, reason: 'Érvénytelen azonosító.' }
    const decision = parseUserDecision(raw)
    if (decision === undefined) return { ok: false, reason: 'Érvénytelen döntés.' }
    return running.decide(id, decision)
  })

  ipcMain.handle('session:focus', async (event, sessionId: unknown) => {
    if (!fromOverlay(event, 'session:focus')) return false
    // IPC-bemenet: a renderer bármit küldhet, ezért `unknown`, és itt ellenőrizzük.
    if (typeof sessionId !== 'string') return false
    const view = running.state().sessions.find((s) => s.sessionId === sessionId)
    if (view === undefined) return false
    // Előbb fókuszálunk, csak utána rejtjük el az overlayt. A Windows csak annak a
    // folyamatnak engedi a SetForegroundWindow-t, amelyik épp az előtérben van —
    // az overlay elrejtése ezt a jogot elvenné tőlünk, és a hívás csendben csak a
    // tálcagombot villogtatná. Ha így is elbukik, a `code` CLI tartalék megoldja.
    const outcome = await focusSessionWindow(view)
    hideOverlay()
    // A pontos tab csak az ablak UTÁN, és csak ha a `tabFocusUri` minden feltétele teljesül.
    // A döntéseket a fókusz UTÁN olvassuk: a várakozás alatt egy fájlírás-kérés is beérkezhetett.
    // Nem várjuk meg: a renderer az ablakfókusz eredményét kapja, ugyanúgy, mint eddig.
    const uri = tabFocusUri(view, outcome, jumpToTab, running.state().decisions)
    if (uri !== undefined) void openTabFocusUri(uri)
    return outcome !== 'failed'
  })

  ipcMain.handle('overlay:hide', (event) => {
    if (!fromOverlay(event, 'overlay:hide')) throw foreignSender()
    hideOverlay()
  })

  ipcMain.handle('settings:get', (event) => {
    if (!fromOverlay(event, 'settings:get')) throw foreignSender()
    return { hideAfterLastDecision }
  })

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

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  // A gyorsbillentyűt a tálca ELŐTT foglaljuk le, mert a menü megjeleníti az eredményt.
  // A showOverlay/toggleOverlay függvénydeklarációk, tehát hoistolódnak: a lentebbi
  // definíciójuk ekkor már hívható. Egy érvénytelen (elgépelt) érték nem állítja meg az
  // indulást: helyette az alapérték él, és a tálca megmondja, mit kell javítani.
  const hotkey = registerHotkeyOrDefault(
    (accelerator, handler) => globalShortcut.register(accelerator, handler),
    config.hotkey,
    toggleOverlay,
  )

  const tray = createTray({
    hotkey,
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
      installIntegration(resolveClaudeDir(), { port: DAEMON_PORT, token })
        .then((conflicts) => {
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
        .finally(syncIntegrationNotice)
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
        .finally(syncIntegrationNotice)
    },
  })

  /**
   * Elavult-e a telepített integráció. Egy korábbi verzió telepítésében nincs benne az azóta
   * hozzáadott hook, és ez magától nem derül ki: az új hook egyszerűen nem tüzel. Indításkor és
   * minden telepítés vagy eltávolítás után fut; a settings.json-t csak olvassa.
   */
  function syncIntegrationNotice(): void {
    readHookInstallState(resolveClaudeDir())
      .then((state) => {
        console.log(
          `[claudeswitcher] hook install state: ${state.kind}` +
            (state.kind === 'stale' ? ` (missing: ${state.missing.join(', ')})` : ''),
        )
        tray.setNotice(integrationNotice(state))
      })
      .catch((error: unknown) => {
        console.error('[claudeswitcher] hook install check failed', error)
      })
  }
  syncIntegrationNotice()

  function showOverlay(): void {
    // Kilépés közben nem hozunk létre új ablakot, és nem mutatjuk a régit.
    if (quitting !== 'no') return
    // A `close` kezelő óta az overlay csak kilépéskor semmisül meg. Ha mégis megsemmisült (egy
    // ismeretlen út), egy új ablak jobb, mint egy „Object has been destroyed" kivétel.
    if (overlay === undefined || overlay.isDestroyed()) overlay = createOverlay()
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
  console.log(`[claudeswitcher] tray ready, ${hotkeyLogText(hotkey)}`)

  const syncTray = (): void => {
    tray.setWaiting(running.state().sessions.filter((s) => s.status === 'waiting').length)
  }
  syncTray()
  const trayTimer = setInterval(syncTray, 1000)
  trayTimer.unref()

  // A kilépéskori takarítás a lenti, egyetlen `before-quit` kezelőé, az fut le pontosan egyszer.
  // Az időzítőt a tálca ELŐTT állítjuk le: a kilépés még legfeljebb STOP_TIMEOUT_MS-ig vár a
  // daemonra, és egy közben lefutó `syncTray` egy megsemmisült tálcaikont érne el.
  cleanup = () => {
    clearInterval(trayTimer)
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
