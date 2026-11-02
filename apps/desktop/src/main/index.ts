import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWin32ProcessProbe, parseUserDecision, resolveClaudeDir } from '@claudeswitcher/core'
import { startDaemon } from '@claudeswitcher/daemon'
import {
  BrowserWindow,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
} from 'electron'
import { createAutostart, type LoginItems } from './autostart.js'
import { loadConfig, saveSettings } from './config.js'
import { TAB_FOCUS_SETTLE_MS, focusSessionWindow, isFastFocusAvailable, tabFocusUri } from './focus-window.js'
import { OVERLAY_CHANNELS } from '../shared/overlay-channels.js'
import { SETUP_CHANNELS, type InstallReply } from '../shared/setup-channels.js'
import { settingsToAsk } from '../shared/settings.js'
import { hardenWindow, loadPage, secureWebPreferences } from './harden-window.js'
import { hotkeyLogText } from './hotkey.js'
import { createHotkeyController } from './hotkey-controller.js'
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
import { createHandleFrom } from './ipc-handle.js'
import { rendererLocation } from './ipc-sender.js'
import { OVERLAY_HEIGHT, OVERLAY_WIDTH, overlayBounds } from './overlay-placement.js'
import { createNativeProcessProbe } from './process-probe.js'
import { createQuitSequence } from './quit-sequence.js'
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
/** Where the overlay loads from; its handlers check the sender against it (`handleFrom`). */
const RENDERER = rendererLocation(process.env['ELECTRON_RENDERER_URL'], RENDERER_DIR, 'index.html')
/** Where the setup window loads from; its handlers check the sender against it (`handleFrom`). */
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
 * Registers an IPC handler that answers only one of our pages. The overlay's handlers pass
 * `RENDERER`, the setup window's `SETUP_PAGE`: in the build each refuses the other page.
 */
const handleFrom = createHandleFrom(ipcMain)

let overlay: BrowserWindow | undefined
/**
 * True when Windows ends the session (shutdown, restart, sign-out). Electron's documentation says
 * `before-quit` does not run then, so `quitSequence.isQuitting()` stays false; the overlay's close
 * must not be held back in that case either.
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
    webPreferences: secureWebPreferences(path.join(dirname, '../preload/index.cjs')),
  })

  // Only our own page may load in it (see `hardenWindow`).
  hardenWindow(window)

  loadPage(window, RENDERER)
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
    if (quitSequence.isQuitting() || sessionEnding) return
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

/** The `userData` directory this instance wrote its record to; the quit sequence removes it. */
let recordedIn: string | undefined
/**
 * The `before-quit` sequence (see `QuitSequence`). Created before `MODE`, so every launch path
 * below may read `isQuitting()` at once.
 */
const quitSequence = createQuitSequence({
  quit: () => {
    app.quit()
  },
  stopWithin,
  // Never throws, and only removes a record that still names this process.
  removeRecord: async () => {
    if (recordedIn !== undefined) await removeInstanceRecord(recordedIn, process.pid)
  },
})

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

/** Shows the overlay once `startApp` has created it; until then a `show` request is ignored. */
let showOverlayWhenStarted: (() => void) | undefined

/**
 * Right after the lock is acquired, before `whenReady` and the startup: the record and the
 * `second-instance` handler exist from the first moment, so a `--quit` or a different build
 * arriving during the (slow) startup is not lost. A `quit` then runs the `before-quit` sequence,
 * which copes with a daemon not started yet (no daemon set, the cleanup still a no-op).
 */
function becomePrimary(): void {
  void recordInstance()
  app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
    switch (instanceAction(parseInstanceMessage(additionalData), THIS_BUILD)) {
      case 'quit':
        // A waiting helper repeats the request until it gets the lock (`closeRunningApp`): log once.
        if (!quitSequence.isQuitting()) console.log('[claudeswitcher] another instance asked this one to quit')
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
  if (quitSequence.isQuitting()) return
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
  // A local, non-null constant: the handlers capture it, so no `!` is needed, and the type
  // guarantees that every handler sees the same running daemon after startup. The quit sequence
  // gets it through `setDaemon`.
  // A natív probe az elsődleges; a PowerShell csak tartalék, ha a koffi nem tölthető be.
  const nativeProbe = createNativeProcessProbe()
  const running = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: nativeProbe ?? createWin32ProcessProbe(),
    port: DAEMON_PORT,
    token,
  })
  quitSequence.setDaemon(running)
  // A quit began while the daemon started: `before-quit` saw no daemon then, so stop this one here.
  if (quitSequence.isQuitting()) {
    await stopWithin(() => running.stop())
    return
  }
  await running.refresh()

  // Every handler first checks the sender (`handleFrom`). Where the reply has a failure shape, a
  // foreign sender gets that; the other handlers throw, which is a rejected promise in the renderer.
  handleFrom(RENDERER, OVERLAY_CHANNELS.connection, () => {
    return { port: running.port, token: running.token }
  })
  handleFrom(RENDERER, OVERLAY_CHANNELS.state, () => {
    return running.state()
  })
  handleFrom(
    RENDERER,
    OVERLAY_CHANNELS.decide,
    (id: unknown, raw: unknown) => {
      // IPC-bemenet: a renderer bármit küldhet. Csak egy pontosan érvényes döntés jut a
      // daemonhoz, annak érvényességét az adott kérésre a broker még külön ellenőrzi.
      if (typeof id !== 'string') return { ok: false, reason: 'Érvénytelen azonosító.' }
      const decision = parseUserDecision(raw)
      if (decision === undefined) return { ok: false, reason: 'Érvénytelen döntés.' }
      return running.decide(id, decision)
    },
    (reason) => ({ ok: false, reason }),
  )

  handleFrom(
    RENDERER,
    OVERLAY_CHANNELS.focusSession,
    async (sessionId: unknown) => {
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
    },
    () => false,
  )

  handleFrom(RENDERER, OVERLAY_CHANNELS.hide, () => {
    hideOverlay()
  })

  handleFrom(RENDERER, OVERLAY_CHANNELS.settings, () => {
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

  // The hotkey is registered BEFORE the tray, because the menu shows the result. `toggleOverlay`
  // is a function declaration, so it is hoisted and callable here. An invalid (mistyped) value
  // does not stop the startup: the default holds instead, and the tray says what to fix.
  const hotkeyController = createHotkeyController({
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => {
      globalShortcut.unregister(accelerator)
    },
    configured: settings.snapshot().values.hotkey,
    onFire: toggleOverlay,
    // `tray` and `setupWindow` are defined below; neither callback runs during startup.
    onRegistrationChanged: (registration, change) => {
      tray.setHotkey(registration)
      // A successful switch is followed by the settings change, which reloads the window.
      if (change !== 'switched') setupWindow.notifyChanged()
    },
    onCaptured: (accelerator) => {
      setupWindow.sendCaptured({ accelerator })
    },
  })
  const hotkey = hotkeyController.registration()

  const setupWindow = createSetupWindowController({
    page: SETUP_PAGE,
    preload: path.join(dirname, '../preload/setup.cjs'),
    capture: { active: hotkeyController.capturing, end: hotkeyController.endCapture },
  })

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
      if (!quitSequence.isQuitting()) setupWindow.open({ showAll: true })
    },
    onQuit: () => {
      app.quit()
    },
    // The integration is handled in the setup window only; the notice line leads there.
    onNotice: () => {
      if (!quitSequence.isQuitting()) setupWindow.open({ showAll: true })
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
   * Installs the Claude Code integration for the setup window (the tray has no install item): shows the
   * dialogs, resyncs the tray notice, and answers the window with a short text. Never rejects.
   */
  function installFromUi(): Promise<InstallReply> {
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
  function uninstallFromUi(): Promise<InstallReply> {
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
    if (quitSequence.isQuitting()) return
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

  // Changes only reach the tray and the window here; the hotkey has already been switched by then.
  settings.onChange((snapshot) => {
    tray.setSettings(snapshot)
    setupWindow.notifyChanged()
  })

  // Every setup handler first checks that the setup page sent it (`handleFrom`).
  handleFrom(SETUP_PAGE, SETUP_CHANNELS.load, async () => {
    const integration = await readHookInstallState(resolveClaudeDir())
    return setupState(settings.snapshot(), { hotkey: hotkeyController.registration(), integration, showAll: setupWindow.showAll() })
  })
  handleFrom(
    SETUP_PAGE,
    SETUP_CHANNELS.save,
    (raw: unknown): Promise<SaveResult> | SaveResult => {
      // IPC input: the renderer may send anything.
      const request = parseSaveRequest(raw)
      if (request === undefined) return { ok: false, reason: 'Érvénytelen kérés.' }
      return saveSetup(request, {
        settings,
        currentHotkey: hotkeyController.registration,
        switchHotkey: hotkeyController.switchTo,
      })
    },
    (reason) => ({ ok: false, reason }),
  )
  handleFrom(
    SETUP_PAGE,
    SETUP_CHANNELS.install,
    () => installFromUi(),
    (reason) => ({ ok: false, message: reason }),
  )
  handleFrom(
    SETUP_PAGE,
    SETUP_CHANNELS.uninstall,
    () => uninstallFromUi(),
    (reason) => ({ ok: false, message: reason }),
  )
  handleFrom(SETUP_PAGE, SETUP_CHANNELS.capture, (active: unknown) => {
    // IPC input: only a literal `true` starts a capture; anything else ends it.
    if (active === true) hotkeyController.startCapture()
    else hotkeyController.endCapture()
    return hotkeyController.capturing()
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

  // The quit cleanup belongs to the quit sequence's single `before-quit` handler, which runs it once.
  // The timer stops BEFORE the tray: the quit still waits up to STOP_TIMEOUT_MS for the daemon, and
  // a `syncTray` running meanwhile would reach a destroyed tray icon.
  quitSequence.setCleanup(() => {
    clearInterval(trayTimer)
    // A capture still running holds temporary shortcuts; end it before everything is released.
    hotkeyController.endCapture()
    globalShortcut.unregisterAll()
    tray.destroy()
  })
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

// The single `before-quit` handler: the quit sequence (`createQuitSequence`).
app.on('before-quit', quitSequence.onBeforeQuit)
