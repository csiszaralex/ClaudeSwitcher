import { spawn } from 'node:child_process'
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
import { createAutostart, type LoginItems } from './autostart.js'
import { loadConfig, saveSettings } from './config.js'
import { TAB_FOCUS_SETTLE_MS, focusSessionWindow, isFastFocusAvailable, tabFocusUri } from './focus-window.js'
import type { HotkeyRegistration } from '../shared/hotkey-status.js'
import { settingsToAsk } from '../shared/settings.js'
import { hardenWindow } from './harden-window.js'
import { hotkeyLogText, registerHotkeyOrDefault, switchHotkey, type HotkeySwitch } from './hotkey.js'
import { CAPTURE_SHORTCUTS, createHotkeyCapture } from './hotkey-capture.js'
import {
  HANDOVER_TIMEOUT_MS,
  LAUNCH_EXIT_CODE,
  describeBuild,
  instanceAction,
  launchMode,
  parseInstanceMessage,
  sameBuild,
  type BuildIdentity,
  type InstanceMessage,
  type LaunchMode,
} from './instance.js'
import { readInstanceRecord, removeInstanceRecord, writeInstanceRecord } from './instance-file.js'
import { isRendererSender, rendererLocation, type RendererLocation } from './ipc-sender.js'
import { OVERLAY_HEIGHT, OVERLAY_WIDTH, overlayBounds } from './overlay-placement.js'
import { createNativeProcessProbe } from './process-probe.js'
import { RELOAD_LIMIT, RELOAD_WINDOW_MS, createReloadLimiter } from './reload-limit.js'
import { createSettingsService } from './settings-service.js'
import { parseSaveRequest, saveSetup, setupState, type SaveResult } from './setup-ipc.js'
import { createSetupWindowController } from './setup-window.js'
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
import { userDataDir } from './user-data.js'
import { waitUntil } from './wait-for-exit.js'

// Must run before `requestSingleInstanceLock`, which is tied to `userData`. The packaged build
// sets `productName`, which would otherwise move the directory and lose the token (see `userDataDir`).
app.setPath('userData', userDataDir(app.getPath('appData')))

const dirname = path.dirname(fileURLToPath(import.meta.url))

const RENDERER_DIR = path.join(dirname, '../renderer')
/** Where the overlay loads from; its handlers check the sender against it (`fromOverlay`). */
const RENDERER = rendererLocation(process.env['ELECTRON_RENDERER_URL'], RENDERER_DIR, 'index.html')
/** Where the setup window loads from; its handlers check the sender against it (`fromSetup`). */
const SETUP_PAGE = rendererLocation(process.env['ELECTRON_RENDERER_URL'], RENDERER_DIR, 'setup.html')

/** This process's build: written to the instance record and sent with the lock request. */
const THIS_BUILD: BuildIdentity = {
  execPath: process.execPath,
  appPath: app.getAppPath(),
  renderer: RENDERER.kind,
  version: app.getVersion(),
  packaged: app.isPackaged,
}

/** Electron's login item, for the running app's settings and for `--uninstall` alike. */
const LOGIN_ITEMS: LoginItems = {
  get: () => app.getLoginItemSettings(),
  set: (openAtLogin) => {
    app.setLoginItemSettings({ openAtLogin })
  },
}

/**
 * True if the IPC call came from the given page of ours (see `isRendererSender`). A foreign sender
 * is logged: if our own page's URL ever differed, the only symptom would otherwise be a silent,
 * empty window.
 */
function fromPage(page: RendererLocation, event: IpcMainInvokeEvent, channel: string): boolean {
  const url = event.senderFrame?.url
  if (isRendererSender(url, page)) return true
  console.error(`[claudeswitcher] refused ${channel} from a foreign sender: ${url ?? '(no frame)'}`)
  return false
}

/** The overlay's handlers: in the build they refuse the setup page too. */
const fromOverlay = (event: IpcMainInvokeEvent, channel: string): boolean => fromPage(RENDERER, event, channel)
/** The setup window's handlers: in the build they refuse the overlay. */
const fromSetup = (event: IpcMainInvokeEvent, channel: string): boolean => fromPage(SETUP_PAGE, event, channel)

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
      preload: path.join(dirname, '../preload/index.cjs'),
      // Ezek az Electron alapértelmezései (a 45-ös típusdefiníciói szerint is). Szándékosan
      // kiírjuk őket: így a biztonsági állás önmagát dokumentálja, és egy jövőbeli
      // Electron-verzió megváltozott alapértéke sem tudja csendben meggyengíteni. A preload
      // csak az `electron` modult tölti be (contextBridge, ipcRenderer), ami sandboxban is működik.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Only our own page may load in it (see `hardenWindow`).
  hardenWindow(window)

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
  // `show` mindig lefut, amikor az ablak ténylegesen láthatóvá válik, és csak akkor.
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
 * egy elbukott megnyitás csak naplózódik: az ablak ilyenkor is elöl van, mint az M1-ben.
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
 *
 * A different build that finds the lock taken asks first, and can hand over (`handOverOrQuit`).
 * The `--quit` and `--uninstall` helpers ask the running app to quit (`runHelper`). Each tells
 * the primary what it wants through the lock request's `additionalData` (`InstanceMessage`).
 */
const MODE = launchMode(process.argv)
const LOCK_MESSAGE: InstanceMessage = MODE === 'normal' ? { kind: 'show', build: THIS_BUILD } : { kind: 'quit' }
const isPrimaryInstance = app.requestSingleInstanceLock(LOCK_MESSAGE)

/** The `userData` directory this instance wrote its record to; the `before-quit` sequence removes it. */
let recordedIn: string | undefined
/** Shows the overlay once `startApp` has created it; until then a `show` request is ignored. */
let showOverlayWhenStarted: (() => void) | undefined

/**
 * Right after the lock is acquired, before `whenReady` and the startup: the record and the
 * `second-instance` handler exist from the first moment, so a `--quit` or a different build
 * arriving during the (slow) startup is not lost. A `quit` then runs the `before-quit` sequence,
 * which copes with a daemon not started yet (`daemon` undefined, `cleanup` still a no-op).
 */
function becomePrimary(): void {
  void recordInstance()
  app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
    switch (instanceAction(parseInstanceMessage(additionalData), THIS_BUILD)) {
      case 'quit':
        // A waiting helper repeats the request until it gets the lock (`closeRunningApp`): log once.
        if (quitting === 'no') console.log('[claudeswitcher] another instance asked this one to quit')
        app.quit()
        break
      case 'show':
        // Egy második indítás (pl. a parancsikonra kattintva) a futó példányt hozza elő.
        showOverlayWhenStarted?.()
        break
      case 'ignore':
        break
    }
  })
}

/** Becomes the primary, then starts the app once Electron is ready. */
function launchPrimary(): Promise<void> {
  becomePrimary()
  return app.whenReady().then(startApp).catch(startupFailed)
}

/** A failed write only costs another build its hand-over dialog: it then quits silently, as before. */
async function recordInstance(): Promise<void> {
  const dir = app.getPath('userData')
  try {
    await writeInstanceRecord(dir, { pid: process.pid, build: THIS_BUILD })
    recordedIn = dir
  } catch (error) {
    console.error('[claudeswitcher] could not write the instance record', error)
  }
}

/**
 * Starts this same build in `--quit` mode. Packaged, the exe is the app. In a repo build the exe
 * is `electron.exe`, which needs the app path first: `electron-vite dev` and `preview` start it as
 * `electron.exe . <args>` in `apps/desktop`, and `app.getAppPath()` is that same directory as an
 * absolute path. The helper runs this same `index.ts`, so it sets the same `userData` and reaches
 * the same lock. Resolves once the helper is gone (or could not start).
 */
function runQuitHelper(): Promise<void> {
  const args = app.isPackaged ? ['--quit'] : [app.getAppPath(), '--quit']
  const helper = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true })
  return new Promise((resolve) => {
    helper.on('error', (error) => {
      console.error('[claudeswitcher] could not start the quit helper', error)
      resolve()
    })
    helper.on('exit', (code) => {
      console.log(`[claudeswitcher] quit helper exited with ${String(code)}`)
      resolve()
    })
  })
}

/**
 * Normal start, lock refused. The same build (or one that left no record) quits silently, and the
 * primary shows the overlay. A different build asks whether to close the running one and take over.
 */
async function handOverOrQuit(): Promise<void> {
  const record = await readInstanceRecord(app.getPath('userData'))
  if (record === undefined || sameBuild(record.build, THIS_BUILD)) {
    console.log('[claudeswitcher] another instance is already running; quitting')
    app.quit()
    return
  }
  await app.whenReady()
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'ClaudeSwitcher',
    message: `Már fut egy ClaudeSwitcher (${describeBuild(record.build)}). Bezárjam, és ez induljon?`,
    buttons: ['Bezárás és indítás', 'Mégse'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) {
    app.quit()
    return
  }
  // Requests the lock only after the helper is gone. While it waits, the helper retries the lock
  // with `{ kind: 'quit' }`: had this build taken the lock first, the helper's next retry would
  // have asked this build to quit (measured by Alex, 2026-11-02). The helper exits once it holds
  // the lock (or gives up after `HANDOVER_TIMEOUT_MS`), and releases it while exiting, so the
  // lock is then polled too. Each refused request sends `{ kind: 'show', build }` to the holder:
  // the exiting helper has no `second-instance` handler, and an old primary that did not quit
  // ignores it (`instanceAction`: a different build).
  await runQuitHelper()
  const tookOver = await waitUntil(() => app.requestSingleInstanceLock(LOCK_MESSAGE), HANDOVER_TIMEOUT_MS)
  console.log(`[claudeswitcher] ${tookOver ? 'took over from' : 'could not take over from'} the running instance`)
  if (tookOver) {
    await launchPrimary()
    return
  }
  dialog.showErrorBox('ClaudeSwitcher', 'A futó ClaudeSwitcher nem zárult be. Zárd be a tálcáról, és indítsd újra.')
  app.quit()
}

/**
 * Lock refused in a helper mode: the lock request has already delivered `{ kind: 'quit' }`, so the
 * primary is running its `before-quit` sequence. True once this process holds the lock, which
 * Electron releases during the primary's quit sequence, after its daemon stopped. That is not the
 * same as the primary process being gone.
 *
 * It waits on the lock itself, not on the pid in the instance record: the primary removes its
 * record while quitting, possibly before this helper gets to read it; the holder may be another
 * helper, which writes no record; and a stale record may name a reused pid. Each retry delivers
 * `{ kind: 'quit' }` again, which a quitting primary ignores (`before-quit`).
 */
function closeRunningApp(): Promise<boolean> {
  return waitUntil(() => app.requestSingleInstanceLock(LOCK_MESSAGE), HANDOVER_TIMEOUT_MS)
}

/**
 * The `--quit` and `--uninstall` launch modes, run by the installer and the uninstaller. They never
 * start the daemon, a window, the tray or the hotkey, and never write the instance record. Exit codes:
 * `LAUNCH_EXIT_CODE`.
 */
async function runHelper(mode: Exclude<LaunchMode, 'normal'>, primary: boolean): Promise<void> {
  // Holding the lock means nothing was running: no wait, and `--quit` exits before `whenReady`.
  const closed = primary || (await closeRunningApp())
  if (!closed) {
    app.exit(LAUNCH_EXIT_CODE.notClosed)
    return
  }
  if (mode === 'quit') {
    app.exit(LAUNCH_EXIT_CODE.ok)
    return
  }
  await app.whenReady()
  try {
    createAutostart(app.isPackaged, LOGIN_ITEMS).set(false)
  } catch (error) {
    console.error('[claudeswitcher] could not remove the autostart entry', error)
  }
  try {
    await uninstallIntegration(resolveClaudeDir())
    app.exit(LAUNCH_EXIT_CODE.ok)
  } catch (error) {
    console.error('[claudeswitcher] could not remove the Claude Code integration', error)
    app.exit(LAUNCH_EXIT_CODE.integrationFailed)
  }
}

switch (MODE) {
  case 'normal':
    if (isPrimaryInstance) void launchPrimary()
    else void handOverOrQuit()
    break
  case 'quit':
  case 'uninstall':
    void runHelper(MODE, isPrimaryInstance)
    break
}

async function startApp(): Promise<void> {
  // A quit that began during startup (an early `--quit`) must not be followed by a daemon and windows.
  if (isQuitting()) return
  // A token tartós, a port rögzített: a telepített hookok ezeket kapják
  // a settings.json-ban, így az app újraindítása után is érvényesek maradnak. Foglalt
  // porton a startDaemon elutasít, és az indulási hibadialógus jelenik meg.
  const userData = app.getPath('userData')
  // Every handler reads the settings from the service at the time of use, so a change from the
  // tray (or the setup window) takes effect at once.
  const settings = createSettingsService({
    stored: await loadConfig(userData),
    autostart: createAutostart(app.isPackaged, LOGIN_ITEMS),
    persist: (patch, confirm) => saveSettings(userData, patch, confirm),
  })
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
  // A quit began while the daemon started: `before-quit` saw no daemon then, so stop this one here.
  if (isQuitting()) {
    await stopWithin(() => running.stop())
    return
  }
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
    // daemonhoz, annak érvényességét az adott kérésre a broker még külön ellenőrzi.
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
    // folyamatnak engedi a SetForegroundWindow-t, amelyik épp az előtérben van:
    // az overlay elrejtése ezt a jogot elvenné tőlünk, és a hívás csendben csak a
    // tálcagombot villogtatná. Ha így is elbukik, a `code` CLI tartalék megoldja.
    const outcome = await focusSessionWindow(view)
    hideOverlay()
    // A pontos tab csak az ablak UTÁN, és csak ha a `tabFocusUri` minden feltétele teljesül.
    // A döntéseket a fókusz UTÁN olvassuk: a várakozás alatt egy fájlírás-kérés is beérkezhetett.
    // Nem várjuk meg: a renderer az ablakfókusz eredményét kapja, ugyanúgy, mint eddig.
    const uri = tabFocusUri(view, outcome, settings.snapshot().values.jumpToTab, running.state().decisions)
    if (uri !== undefined) void openTabFocusUri(uri)
    return outcome !== 'failed'
  })

  ipcMain.handle('overlay:hide', (event) => {
    if (!fromOverlay(event, 'overlay:hide')) throw foreignSender()
    hideOverlay()
  })

  ipcMain.handle('settings:get', (event) => {
    if (!fromOverlay(event, 'settings:get')) throw foreignSender()
    return { hideAfterLastDecision: settings.snapshot().values.hideAfterLastDecision }
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

  const setupWindow = createSetupWindowController({
    page: SETUP_PAGE,
    preload: path.join(dirname, '../preload/setup.cjs'),
    // `capture` and `endCapture` are defined below; the window only calls them after startup.
    capture: {
      active: () => capture.active(),
      end: () => {
        endCapture()
      },
    },
  })

  // A gyorsbillentyűt a tálca ELŐTT foglaljuk le, mert a menü megjeleníti az eredményt.
  // A showOverlay/toggleOverlay függvénydeklarációk, tehát hoistolódnak: a lentebbi
  // definíciójuk ekkor már hívható. Egy érvénytelen (elgépelt) érték nem állítja meg az
  // indulást: helyette az alapérték él, és a tálca megmondja, mit kell javítani.
  const register = (accelerator: string, handler: () => void): boolean => globalShortcut.register(accelerator, handler)
  const hotkey = registerHotkeyOrDefault(register, settings.snapshot().values.hotkey, toggleOverlay)

  const tray = createTray({
    settings: settings.snapshot(),
    hotkey,
    // A tray change confirms that setting. It holds at once even if saving fails (for example a
    // broken config file), then only until the app quits.
    onToggle: (key, enabled) => {
      void settings.apply({ [key]: enabled }, [key])
    },
    onOpen: () => {
      showOverlay()
    },
    onSettings: () => {
      if (quitting === 'no') setupWindow.open({ showAll: true })
    },
    onQuit: () => {
      app.quit()
    },
    // The integration is handled in the setup window only; the notice line leads there.
    onNotice: () => {
      if (quitting === 'no') setupWindow.open({ showAll: true })
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
        // An open setup window shows the integration state too.
        setupWindow.notifyChanged()
      })
      .catch((error: unknown) => {
        console.error('[claudeswitcher] hook install check failed', error)
      })
  }
  syncIntegrationNotice()

  /**
   * Installs the Claude Code integration for the tray item and the setup window alike: shows the
   * dialogs, resyncs the tray notice, and answers the window with a short text. Never rejects.
   */
  function installFromUi(): Promise<{ ok: boolean; message: string }> {
    return installIntegration(resolveClaudeDir(), { port: DAEMON_PORT, token })
      .then((conflicts) => {
        const message =
          conflicts.length === 0
            ? 'A Claude Code integráció telepítve.'
            : 'A Claude Code integráció csak részben települt.'
        void dialog.showMessageBox({
          type: conflicts.length === 0 ? 'info' : 'warning',
          title: 'ClaudeSwitcher',
          message,
          detail: [
            ...conflicts,
            'Az újonnan indított Claude Code sessionök már jelentenek. A már futó sessionöket lehet, hogy újra kell indítani.',
          ].join('\n\n'),
        })
        return { ok: conflicts.length === 0, message }
      })
      .catch((error: unknown) => {
        dialog.showErrorBox('A telepítés nem sikerült', describeError(error))
        return { ok: false, message: `A telepítés nem sikerült: ${describeError(error)}` }
      })
      .finally(syncIntegrationNotice)
  }

  /** Removes the Claude Code integration for the setup window: dialogs, notice resync, a short text. Never rejects. */
  function uninstallFromUi(): Promise<{ ok: boolean; message: string }> {
    return uninstallIntegration(resolveClaudeDir())
      .then(() => {
        const message = 'A Claude Code integráció eltávolítva.'
        void dialog.showMessageBox({ type: 'info', title: 'ClaudeSwitcher', message })
        return { ok: true, message }
      })
      .catch((error: unknown) => {
        dialog.showErrorBox('Az eltávolítás nem sikerült', describeError(error))
        return { ok: false, message: `Az eltávolítás nem sikerült: ${describeError(error)}` }
      })
      .finally(syncIntegrationNotice)
  }

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

  /** The accelerator the app actually holds: the configured one, or the default it fell back to. */
  const heldAccelerator = (registration: HotkeyRegistration): string =>
    registration.status !== 'invalid' || registration.fallback === undefined
      ? registration.requested
      : registration.fallback.accelerator
  let heldHotkey = heldAccelerator(hotkey)
  /** The registration that holds now, for the tray and the setup window. */
  let currentHotkey = hotkey

  /** Suspends the held hotkey while the setup window captures a new one (`setup:capture`). */
  const capture = createHotkeyCapture({
    register,
    unregister: (accelerator) => {
      globalShortcut.unregister(accelerator)
    },
    held: () => heldHotkey,
    handler: toggleOverlay,
    temporaries: CAPTURE_SHORTCUTS,
    // A temporary shortcut fired: that is the captured combination. Ended on the next tick, outside
    // the shortcut's own callback, because ending unregisters that very shortcut.
    onTemporary: (accelerator) => {
      setImmediate(() => {
        if (!capture.active()) return
        endCapture()
        setupWindow.sendCaptured({ accelerator })
      })
    },
  })
  /** Every end of a capture comes here. If the held hotkey was taken meanwhile, the tray and the window say so. */
  const endCapture = (): void => {
    const status = capture.stop()
    if (status === undefined || status === 'registered') return
    currentHotkey = { requested: heldHotkey, status }
    tray.setHotkey(currentHotkey)
    console.log(`[claudeswitcher] after capture: ${hotkeyLogText(currentHotkey)}`)
    setupWindow.notifyChanged()
  }

  /**
   * The setup window's hotkey change. `saveSetup` calls it BEFORE applying anything, so a refused
   * hotkey is never applied, persisted or confirmed. The tray shows what holds afterwards either way.
   */
  const switchTo = (next: string): HotkeySwitch => {
    // A capture still running would register the held hotkey again on top of the switch.
    endCapture()
    const result = switchHotkey(
      {
        register,
        unregister: (accelerator) => {
          globalShortcut.unregister(accelerator)
        },
      },
      heldHotkey,
      next,
      toggleOverlay,
    )
    currentHotkey = result.registration
    if (result.switched) heldHotkey = next
    tray.setHotkey(result.registration)
    console.log(`[claudeswitcher] ${hotkeyLogText(result.registration)}`)
    // A refusal applies nothing, so no change event follows; the window still has to see what holds.
    if (!result.switched) setupWindow.notifyChanged()
    return result
  }

  // Changes only reach the tray and the window here; the hotkey has already been switched by then.
  settings.onChange((snapshot) => {
    tray.setSettings(snapshot)
    setupWindow.notifyChanged()
  })

  // Every setup handler first checks that the setup page sent it (`fromSetup`).
  ipcMain.handle('setup:load', async (event) => {
    if (!fromSetup(event, 'setup:load')) throw foreignSender()
    const integration = await readHookInstallState(resolveClaudeDir())
    return setupState(settings.snapshot(), { hotkey: currentHotkey, integration, showAll: setupWindow.showAll() })
  })
  ipcMain.handle('setup:save', (event, raw: unknown): Promise<SaveResult> | SaveResult => {
    if (!fromSetup(event, 'setup:save')) return { ok: false, reason: FOREIGN_SENDER }
    // IPC input: the renderer may send anything.
    const request = parseSaveRequest(raw)
    if (request === undefined) return { ok: false, reason: 'Érvénytelen kérés.' }
    return saveSetup(request, { settings, currentHotkey: () => currentHotkey, switchHotkey: switchTo })
  })
  ipcMain.handle('setup:install', (event) => {
    if (!fromSetup(event, 'setup:install')) return { ok: false, message: FOREIGN_SENDER }
    return installFromUi()
  })
  ipcMain.handle('setup:uninstall', (event) => {
    if (!fromSetup(event, 'setup:uninstall')) return { ok: false, message: FOREIGN_SENDER }
    return uninstallFromUi()
  })
  ipcMain.handle('setup:capture', (event, active: unknown) => {
    if (!fromSetup(event, 'setup:capture')) throw foreignSender()
    // IPC input: only a literal `true` starts a capture; anything else ends it.
    if (active === true) capture.start()
    else endCapture()
    return capture.active()
  })

  // The window opens by itself only while a setting is unconfirmed; the integration never opens it.
  const startup = settings.snapshot()
  const toAsk = settingsToAsk(startup.confirmed, { autostartAvailable: startup.autostartAvailable })
  console.log(`[claudeswitcher] setup window: ${toAsk.length > 0 ? `asking ${toAsk.join(', ')}` : 'nothing to ask'}`)
  if (toAsk.length > 0) setupWindow.open({ showAll: false })

  // From here on a second start of the same build brings the overlay up (`becomePrimary`).
  showOverlayWhenStarted = showOverlay

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
    // A capture still running holds temporary shortcuts; end it before everything is released.
    endCapture()
    globalShortcut.unregisterAll()
    tray.destroy()
  }
}

function startupFailed(error: unknown): void {
  // Tálcaikonos app: ha az indulás elbukik (tipikusan a daemon), nincs ablak és
  // nincs tálcaikon, a processz csendben halott maradna, a felhasználó pedig csak
  // azt látná, hogy „nem csinál semmit". A showErrorBox szinkron és ablak nélkül
  // is működik, tehát ez az egyetlen hely, ahol a hiba biztosan eljut hozzá.
  console.error('[claudeswitcher] startup failed', error)
  dialog.showErrorBox(
    'A ClaudeSwitcher nem tudott elindulni',
    error instanceof Error ? error.message : String(error),
  )
  app.quit()
}

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
/** A function, so a check after an `await` is not narrowed away by the check before it. */
function isQuitting(): boolean {
  return quitting !== 'no'
}
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
  void stopped.then(async (inTime) => {
    if (!inTime) console.error('[claudeswitcher] daemon did not stop in time; quitting anyway')
    // After the daemon released the port: a build waiting for this pid may start once it is gone.
    // Never throws, and only removes a record that still names this process.
    if (recordedIn !== undefined) await removeInstanceRecord(recordedIn, process.pid)
    quitting = 'done'
    app.quit()
  })
})
