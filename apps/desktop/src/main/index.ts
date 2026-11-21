import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DAEMON_HOST,
  createWin32ProcessProbe,
  findTranscriptPath,
  parseUserDecision,
  readTranscriptConversation,
  resolveClaudeDir,
} from '@claudeswitcher/core'
import { startDaemon } from '@claudeswitcher/daemon'
import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  shell,
} from 'electron'
import { APP_USER_MODEL_ID } from './app-id.js'
import { createAutostart, type LoginItems } from './autostart.js'
import { createConversationReader } from './conversation-reader.js'
import { loadConfig, saveSettings, saveSkippedVersion } from './config.js'
import { createFocusReturn } from './focus-return.js'
import {
  TAB_FOCUS_SETTLE_MS,
  captureForeground,
  focusSessionWindow,
  giveBackForeground,
  isFastFocusAvailable,
  readForegroundTitle,
  tabFocusUri,
  type FocusOutcome,
} from './focus-window.js'
import { errorMessage } from '../shared/error-message.js'
import { acknowledgeFinish } from '../shared/session-finished.js'
import { OVERLAY_CHANNELS, type ConversationReply } from '../shared/overlay-channels.js'
import { SETUP_CHANNELS, type InstallReply } from '../shared/setup-channels.js'
import { settingsToAsk } from '../shared/settings.js'
import { hotkeyLogText } from './hotkey.js'
import { createHotkeyController } from './hotkey-controller.js'
import {
  HANDOVER_TIMEOUT_MS,
  HELPER_FLAG,
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
import { ensureLogFile, installFileLog } from './log-file.js'
import { createNotifier } from './notifier.js'
import { createOverlayController } from './overlay-window.js'
import { createNativeProcessProbe } from './process-probe.js'
import { createQuitSequence } from './quit-sequence.js'
import { SEEN_JUMP_HOLD_MS, SEEN_POLL_MS, createSeenWatch, showsSessionTab, watchesSeen } from './seen-elsewhere.js'
import { createSettingsService } from './settings-service.js'
import { parseSaveRequest, saveSetup, setupState, type SaveResult } from './setup-ipc.js'
import { createSetupWindowController } from './setup-window.js'
import {
  DAEMON_PORT,
  installIntegration,
  integrationNotice,
  readHookInstallState,
  uninstallIntegration,
} from './claude-integration.js'
import { stopWithin } from './shutdown.js'
import { loadOrCreateToken } from './token.js'
import { createToaster } from './toast.js'
import { createTray } from './tray.js'
import { trayState } from './tray-state.js'
import {
  CONSOLE_UPDATER_LOG,
  createUpdateController,
  updateChoice,
  updateNotice,
  updatePrompt,
  type UpdateController,
} from './updater.js'
import { userDataDir } from './user-data.js'
import { waitUntil } from './wait-for-exit.js'

// Must run before `requestSingleInstanceLock`, which is tied to `userData`. The packaged build
// sets `productName`, which would otherwise move the directory and lose the token (see `userDataDir`).
app.setPath('userData', userDataDir(app.getPath('appData')))

// Right after `userData` is known, so every later line is caught, the `--quit` helper's too (its
// pid tells the two apart). The daemon and core run in this process, so their `console` lines land
// in the file without a call-site change.
installFileLog({ userData: app.getPath('userData'), target: console, now: () => new Date(), pid: process.pid })
console.log(
  `[claudeswitcher] start: version ${app.getVersion()}, ${app.isPackaged ? 'packaged' : 'repo build'}, electron ${process.versions.electron}`,
)

// `uncaughtExceptionMonitor` only observes: Electron's own handling (its error dialog) stays.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.error(`[claudeswitcher] ${origin}`, error)
})
// Deliberately log and go on. Under Node's default mode (`throw`) a rejection without a handler
// becomes an uncaught exception; with this handler it does not, whatever Electron's own default is.
// A tray app that holds permission requests must not go down over one stray promise: the line in
// the log is what we need to find it.
process.on('unhandledRejection', (reason) => {
  console.error('[claudeswitcher] unhandled rejection', reason)
})

const dirname = path.dirname(fileURLToPath(import.meta.url))
/** Loads electron-updater (externalized, like koffi) only where it is used: in the installed app. */
const requireRuntime = createRequire(import.meta.url)

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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sends the tab focus URI to VSCode after waiting `TAB_FOCUS_SETTLE_MS`, unless `skipReason`, read
 * after the wait, names a reason not to (the tab is in front already, or the user opened the
 * overlay again). VS Code takes the focus when it handles the URI, which hides an overlay opened in
 * the meantime, so the URI goes only when it changes something. Never throws: a failed open is only
 * logged, and the window is in front anyway, as it was before the tab focus existed.
 */
async function openTabFocusUri(uri: string, skipReason: () => string | undefined): Promise<void> {
  await wait(TAB_FOCUS_SETTLE_MS)
  const skip = skipReason()
  if (skip !== undefined) {
    console.log(`[focus] tab focus URI not sent: ${skip}`)
    return
  }
  try {
    await shell.openExternal(uri)
  } catch (error) {
    console.error('[focus] could not open the tab focus URI; the window stays focused', error)
  }
}

/** How often `logTabArrival` reads the foreground window, for at most `SEEN_JUMP_HOLD_MS` after a jump. */
const TAB_ARRIVAL_POLL_MS = 50

/**
 * Logs how long after a jump (`jumpedAt`) the foreground window showed the session's tab (`shows`),
 * or that it did not within `SEEN_JUMP_HOLD_MS`. Only a measurement: the time from the jump to the
 * tab is not known (`docs/design.md`), and it bounds both the hold of the seen watch and how soon
 * the overlay can be opened again without VS Code taking the focus.
 */
async function logTabArrival(sessionId: string, jumpedAt: number, shows: () => boolean): Promise<void> {
  for (;;) {
    const elapsed = Date.now() - jumpedAt
    if (shows()) {
      console.log(`[focus] the tab of session ${sessionId} was in front ${String(elapsed)} ms after the jump`)
      return
    }
    if (elapsed >= SEEN_JUMP_HOLD_MS) break
    await wait(TAB_ARRIVAL_POLL_MS)
  }
  console.log(`[focus] the tab of session ${sessionId} was not in front within ${String(SEEN_JUMP_HOLD_MS)} ms of the jump`)
}

/** Opens the log file with the default application; the file is created first, so there is always something to open. */
function openLog(): void {
  try {
    shell
      .openPath(ensureLogFile(app.getPath('userData')))
      .then((failure) => {
        // `openPath` resolves with an error message, an empty string on success.
        if (failure !== '') console.error('[claudeswitcher] could not open the log file', failure)
      })
      .catch((error: unknown) => {
        console.error('[claudeswitcher] could not open the log file', error)
      })
  } catch (error) {
    console.error('[claudeswitcher] could not create the log file', error)
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
 * One instance at a time. A second instance would fail on the fixed port (with an error dialog),
 * and through the shared `userData` it would also tangle the Chromium cache ("Unable to move the
 * cache: Access is denied"). So the second instance quits silently, before it takes the port or
 * opens any window; the first one shows the overlay on the `second-instance` event.
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
        // A second start (clicking the shortcut, for example) brings up the running instance.
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
  const args = app.isPackaged ? [HELPER_FLAG.quit] : [app.getAppPath(), HELPER_FLAG.quit]
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
  // have asked this build to quit (measured live, 2026-11-02). The helper exits once it holds
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
  // So a toast is attributed to the app: the installer's Start menu shortcut carries the same ID
  // (`resources/installer.nsh` `csApplyShortcut`, from `appId`). Electron 45.1.0's `electron.d.ts`
  // says only "Changes the Application User Model ID" and nothing about what a toast needs beyond
  // it, so whether a repo build (no installer shortcut) shows toasts is not settled by the types and
  // was not measured (agents never launch the app). The installed app is what counts. It runs here,
  // so not in the `--quit` and `--uninstall` helpers, which show nothing.
  app.setAppUserModelId(APP_USER_MODEL_ID)
  // The token is persistent and the port is fixed: the installed hooks get these in settings.json,
  // so they stay valid after the app restarts. On a taken port startDaemon rejects, and the startup
  // error dialog appears.
  const userData = app.getPath('userData')
  // Every handler reads the settings from the service at the time of use, so a change from the
  // tray (or the setup window) takes effect at once.
  const stored = await loadConfig(userData)
  const settings = createSettingsService({
    stored,
    autostart: createAutostart(app.isPackaged, LOGIN_ITEMS),
    persist: (patch, confirm) => saveSettings(userData, patch, confirm),
  })
  const token = await loadOrCreateToken(userData)
  // A local, non-null constant: the handlers capture it, so no `!` is needed, and the type
  // guarantees that every handler sees the same running daemon after startup. The quit sequence
  // gets it through `setDaemon`.
  // The native probe comes first; PowerShell is only the fallback when koffi cannot be loaded.
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

  // The finishes the user has seen (`acknowledgeFinish`): by opening the session from the overlay
  // (`focusSession`), or by keeping its VS Code tab in front (`watchSeen`). The tray tick and the
  // overlay (`OVERLAY_CHANNELS.finishesSeen`) read them. In memory only, as the daemon's `stoppedAt`
  // itself (`SessionStore`).
  const finishesSeen = new Map<string, number>()
  // The watch that counts a finish as seen when its VS Code tab stays in front (`watchSeen` below);
  // here, before the jump handler, which holds it while a jump brings up a tab (`jumpedTo`).
  const seenWatch = createSeenWatch()
  // Whether a jump is bringing up a window now (`OVERLAY_CHANNELS.focusSession`): one at a time.
  let jumpInFlight = false

  // Every handler first checks the sender (`handleFrom`). Where the reply has a failure shape, a
  // foreign sender gets that; the other handlers throw, which is a rejected promise in the renderer.
  handleFrom(RENDERER, OVERLAY_CHANNELS.connection, () => {
    return { port: running.port, token: running.token }
  })
  handleFrom(RENDERER, OVERLAY_CHANNELS.state, () => {
    return running.state()
  })
  handleFrom(RENDERER, OVERLAY_CHANNELS.finishesSeen, () => {
    return [...finishesSeen]
  })
  handleFrom(
    RENDERER,
    OVERLAY_CHANNELS.decide,
    (id: unknown, raw: unknown) => {
      // IPC input: the renderer may send anything. Only a strictly valid decision reaches the
      // daemon, and the broker checks separately that it is valid for that request.
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
      // IPC input: the renderer may send anything, hence `unknown`, checked here.
      if (typeof sessionId !== 'string') return false
      const { sessions } = running.state()
      const view = sessions.find((s) => s.sessionId === sessionId)
      if (view === undefined) return false
      // One jump at a time: a held Enter repeats its keydown, and each repeat started another jump
      // while the first still brought the window up (the owner's log, 2026-11-21: six jumps to one
      // session within 0.4 s). A request that arrives meanwhile is dropped.
      if (jumpInFlight) return false
      // Before the window comes up: until it shows this session's tab, the tab active before in that
      // window must not count as seen by the watch (`SEEN_JUMP_HOLD_MS`).
      const jumpedAt = Date.now()
      seenWatch.jumpedTo(view.sessionId, jumpedAt)
      // Focus first, hide the overlay only afterwards. Windows allows SetForegroundWindow only to
      // the process currently in the foreground: hiding the overlay would take that right away, and
      // the call would silently just flash the taskbar button. If it fails anyway, the `code` CLI
      // fallback handles it.
      let outcome: FocusOutcome
      jumpInFlight = true
      try {
        outcome = await focusSessionWindow(view, (window) =>
          showsSessionTab(window, running.state().sessions, view.sessionId),
        )
      } finally {
        jumpInFlight = false
      }
      // So the jump's paths and their times can be measured (`focus-window.ts` `focusWith`).
      console.log(`[focus] session ${view.sessionId}: window by ${outcome} in ${String(Date.now() - jumpedAt)} ms`)
      overlay.hide()
      // The user has opened the session from the overlay: its finish is seen whatever the outcome
      // (a session whose window cannot be brought forward, such as a terminal the console search
      // does not recognise, fails every time and would otherwise stay green). The tray's done mark
      // goes and the list's ✓ turns blue (`finishState`). Recorded only after `overlay.hide()`: the
      // overlay reads the map on `shown` (`useSeenFinishes`), so its next pull has this finish. A
      // session that waits on the sessions it prompted records nothing (`acknowledgeFinish`).
      acknowledgeFinish(finishesSeen, view, sessions)
      // The exact tab only AFTER the window, and only if every condition of `tabFocusUri` holds.
      // The decisions are read AFTER the focus: a file-write request may have arrived during the
      // wait. Not awaited: the renderer gets the result of the window focus, as before.
      const uri = tabFocusUri(view, outcome, settings.snapshot().values.jumpToTab, running.state().decisions)
      if (uri !== undefined) {
        const showsTab = (): boolean => showsSessionTab(readForegroundTitle(), running.state().sessions, view.sessionId)
        void openTabFocusUri(uri, () => {
          if (overlay.isVisible()) return 'the overlay is open again'
          if (showsTab()) return 'the tab is in front already'
          return undefined
        })
        if (view.activity.tabTitle !== undefined) void logTabArrival(view.sessionId, jumpedAt, showsTab)
      }
      return outcome !== 'failed'
    },
    () => false,
  )

  // The peek (Space on a row): the session's recent conversation, read from its transcript by core,
  // only for a session the daemon lists, so the renderer cannot name any other file.
  const readConversation = createConversationReader({
    isLiveSession: (sessionId) => running.state().sessions.some((s) => s.sessionId === sessionId),
    findPath: (sessionId) => findTranscriptPath(resolveClaudeDir(), sessionId),
    stat: (file) =>
      stat(file).then(
        (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
        () => undefined,
      ),
    read: (file) => readTranscriptConversation(file),
  })
  handleFrom(
    RENDERER,
    OVERLAY_CHANNELS.conversation,
    (sessionId: unknown): ConversationReply | Promise<ConversationReply> => {
      // IPC input: the renderer may send anything, hence `unknown`, checked here.
      if (typeof sessionId !== 'string') return { ok: false, reason: 'unknown-session' }
      return readConversation(sessionId)
    },
    (): ConversationReply => ({ ok: false, reason: 'unknown-session' }),
  )

  // Esc, and the hide after the last decision: the user is done with the list, so the focus goes
  // back to the window in front before it opened (`dismiss`). Not the jump above, which brings up
  // the session's window on purpose.
  handleFrom(RENDERER, OVERLAY_CHANNELS.hide, () => overlay.dismiss())

  handleFrom(RENDERER, OVERLAY_CHANNELS.settings, () => {
    return { hideAfterLastDecision: settings.snapshot().values.hideAfterLastDecision }
  })

  // The status bar's version: the installed app's release, a repo build its `package.json` version.
  handleFrom(RENDERER, OVERLAY_CHANNELS.appVersion, () => app.getVersion())

  // A startup summary on the main process's stdout. It makes the startup check automatable: no
  // typing into the DevTools console is needed to see that the daemon started and really found the
  // running sessions.
  console.log(
    `[claudeswitcher] daemon on ${DAEMON_HOST}:${running.port}, ` +
      `${running.state().sessions.length} session(s) discovered, ` +
      `fast focus ${isFastFocusAvailable() ? 'available' : 'UNAVAILABLE'}, ` +
      `process probe ${nativeProbe === undefined ? 'PowerShell (fallback)' : 'native'}`,
  )

  // Created after the overlay handlers above: its page invokes them as soon as it has loaded. Only
  // the overlay's preload exposes them, so none of them can reach `overlay` before this line.
  const overlay = createOverlayController({
    page: RENDERER,
    preload: path.join(dirname, '../preload/index.cjs'),
    isQuitting: quitSequence.isQuitting,
    focusReturn: createFocusReturn({ capture: captureForeground, restore: giveBackForeground }),
  })

  // The hotkey is registered BEFORE the tray, because the menu shows the result. An invalid
  // (mistyped) value does not stop the startup: the default holds instead, and the tray says what
  // to fix.
  const hotkeyController = createHotkeyController({
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => {
      globalShortcut.unregister(accelerator)
    },
    configured: settings.snapshot().values.hotkey,
    onFire: overlay.toggle,
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
      overlay.show()
    },
    onSettings: () => {
      if (!quitSequence.isQuitting()) setupWindow.open({ showAll: true })
    },
    onOpenLog: openLog,
    onQuit: () => {
      app.quit()
    },
    // The integration is handled in the setup window only; the notice line leads there.
    onNotice: () => {
      if (!quitSequence.isQuitting()) setupWindow.open({ showAll: true })
    },
    // `updates` is defined below. The update item is shown only with it (`onItem`), that is in the
    // installed app, and offers the install only while a downloaded update is on offer.
    onInstallUpdate: () => {
      if (!quitSequence.isQuitting()) updates?.install()
    },
    onCheckUpdate: () => {
      if (!quitSequence.isQuitting()) updates?.checkNow()
    },
  })

  // The installed app only: a repo build has no `app-update.yml` and no updater at all, so no
  // check and no update item.
  const updates: UpdateController | undefined = app.isPackaged
    ? createUpdateController({
        updater: (requireRuntime('electron-updater') as typeof import('electron-updater')).autoUpdater,
        enabled: settings.snapshot().values.checkForUpdates,
        // No parent window: the overlay is hidden by then, and the setup window may be closed.
        prompt: (version) =>
          dialog.showMessageBox(updatePrompt(version, app.getVersion())).then(({ response }) => updateChoice(response)),
        notify: (notice) => dialog.showMessageBox(updateNotice(notice, app.getVersion())),
        onItem: (item) => {
          tray.setUpdateItem(item)
        },
        overlayVisible: overlay.isVisible,
        onOverlayHidden: overlay.onHidden,
        skippedVersion: stored.skippedVersion,
        saveSkipped: (version) => saveSkippedVersion(userData, version),
        log: CONSOLE_UPDATER_LOG,
      })
    : undefined
  console.log(
    `[claudeswitcher] updater: ${updates === undefined ? 'none (repo build)' : `checks ${settings.snapshot().values.checkForUpdates ? 'on' : 'off'}`}`,
  )

  /**
   * Whether the installed integration is stale. An install by an earlier version lacks a hook added
   * since, and that does not show by itself: the new hook simply does not fire. Runs at startup and
   * after every install or uninstall; it only reads settings.json.
   */
  function syncIntegrationNotice(): void {
    readHookInstallState(resolveClaudeDir(), token)
      .then((state) => {
        console.log(
          `[claudeswitcher] hook install state: ${state.kind}` +
            (state.kind === 'stale'
              ? ` (missing: ${state.missing.length > 0 ? state.missing.join(', ') : 'none'}${state.tokenMismatch ? '; token mismatch' : ''})`
              : ''),
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
            ? 'A Claude Code-integráció telepítve.'
            : 'A Claude Code-integráció csak részben települt.'
        void dialog.showMessageBox({
          type: conflicts.length === 0 ? 'info' : 'warning',
          title: 'ClaudeSwitcher',
          message,
          detail: [
            ...conflicts,
            'Az újonnan indított Claude Code-sessionök már jelentenek az appnak. A már futó sessionöket lehet, hogy újra kell indítani.',
          ].join('\n\n'),
        })
        return { ok: conflicts.length === 0, message }
      })
      .catch((error: unknown) => {
        dialog.showErrorBox('A telepítés nem sikerült', errorMessage(error))
        return { ok: false, message: `A telepítés nem sikerült: ${errorMessage(error)}` }
      })
      .finally(syncIntegrationNotice)
  }

  /** Removes the Claude Code integration for the setup window: dialogs, notice resync, a short text. Never rejects. */
  function uninstallFromUi(): Promise<InstallReply> {
    return uninstallIntegration(resolveClaudeDir())
      .then(() => {
        const message = 'A Claude Code-integráció eltávolítva.'
        void dialog.showMessageBox({ type: 'info', title: 'ClaudeSwitcher', message })
        return { ok: true, message }
      })
      .catch((error: unknown) => {
        dialog.showErrorBox('Az eltávolítás nem sikerült', errorMessage(error))
        return { ok: false, message: `Az eltávolítás nem sikerült: ${errorMessage(error)}` }
      })
      .finally(syncIntegrationNotice)
  }

  // Changes only reach the tray and the window here; the hotkey has already been switched by then.
  settings.onChange((snapshot) => {
    tray.setSettings(snapshot)
    setupWindow.notifyChanged()
    // Live, without a restart: off stops the checks, on checks now.
    updates?.setEnabled(snapshot.values.checkForUpdates)
  })

  // Every setup handler first checks that the setup page sent it (`handleFrom`).
  handleFrom(SETUP_PAGE, SETUP_CHANNELS.load, async () => {
    const integration = await readHookInstallState(resolveClaudeDir(), token)
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
  const toAsk = settingsToAsk(startup.confirmed, { installed: startup.installed })
  console.log(`[claudeswitcher] setup window: ${toAsk.length > 0 ? `asking ${toAsk.join(', ')}` : 'nothing to ask'}`)
  if (toAsk.length > 0) setupWindow.open({ showAll: false })

  // From here on a second start of the same build brings the overlay up (`becomePrimary`).
  showOverlayWhenStarted = overlay.show

  // The tray and hotkey state on stdout. It makes the tray check measurable without pressing a key:
  // createTray throws on an empty icon, so if this line appears, the tray icon got a visible image.
  console.log(`[claudeswitcher] tray ready, ${hotkeyLogText(hotkey)}`)

  // A toast click opens the list on that session. `overlay.show` ignores the call while quitting.
  const showToast = createToaster((sessionId) => {
    overlay.show(sessionId)
  })
  const notifier = createNotifier()

  // A finish counts as seen too when its VS Code tab stays in front (`main/seen-elsewhere.ts`). The
  // foreground window is read every `SEEN_POLL_MS`, only while such a finish may be seen
  // (`watchesSeen`): the tray tick starts the timer, and the timer stops itself when nothing is left.
  // Its own timer, because the tray tick's second is too coarse for the dwell. Without the user32
  // bindings it never starts.
  let seenTimer: ReturnType<typeof setInterval> | undefined
  let seenWatchOff = !isFastFocusAvailable()
  const stopSeenWatch = (): void => {
    if (seenTimer !== undefined) clearInterval(seenTimer)
    seenTimer = undefined
  }
  const watchSeen = (): void => {
    try {
      const { sessions } = running.state()
      const watching = watchesSeen(sessions, finishesSeen)
      // While the overlay is up the user looks at the list, which reads the seen map only on `shown`
      // (`useSeenFinishes`): a finish seen meanwhile would stay green there. The overlay hides on
      // blur, so it is up without the focus only when Windows refused it the focus. No foreground
      // also ends the dwell, so a stopped watch starts from nothing next time.
      const foreground = !watching || overlay.isVisible() ? undefined : readForegroundTitle()
      const seenNow = seenWatch.observe({ foreground, sessions, seen: finishesSeen, now: Date.now() })
      // The tray shows it on its next tick: an extra `setState` would put the flash out of step.
      if (seenNow !== undefined) {
        acknowledgeFinish(finishesSeen, seenNow, sessions)
        // So a finish that stays green can be told apart from one the app saw: the log shows each one it counted.
        console.log(`[seen] session ${seenNow.sessionId} counts as seen: its tab was in front`)
      }
      if (!watching) stopSeenWatch()
    } catch (error) {
      // Logged once, then off until the app restarts: a failure every half second would flood the log.
      console.error('[seen] reading the foreground window failed; finishes count as seen only from the list', error)
      seenWatchOff = true
      stopSeenWatch()
    }
  }

  const syncTray = (): void => {
    const state = running.state()
    tray.setState(trayState({ ...state, acknowledged: finishesSeen, now: Date.now() }))
    if (seenTimer === undefined && !seenWatchOff && watchesSeen(state.sessions, finishesSeen)) {
      seenTimer = setInterval(watchSeen, SEEN_POLL_MS)
      seenTimer.unref()
    }
    // Never lets a failing toast stop the tray tick.
    try {
      const { notifyOnRequest, notifyOnFinish } = settings.snapshot().values
      for (const notice of notifier.observe({
        state,
        settings: { notifyOnRequest, notifyOnFinish },
        overlayVisible: overlay.isVisible(),
      })) {
        showToast(notice)
      }
    } catch (error) {
      console.error('[claudeswitcher] notification check failed', error)
    }
  }
  syncTray()
  const trayTimer = setInterval(syncTray, 1000)
  trayTimer.unref()

  // The quit cleanup belongs to the quit sequence's single `before-quit` handler, which runs it once.
  // The timer stops BEFORE the tray: the quit still waits up to STOP_TIMEOUT_MS for the daemon, and
  // a `syncTray` running meanwhile would reach a destroyed tray icon.
  quitSequence.setCleanup(() => {
    clearInterval(trayTimer)
    stopSeenWatch()
    // Before the tray too: a download finishing during the quit must not reach the destroyed icon.
    updates?.stop()
    // A capture still running holds temporary shortcuts; end it before everything is released.
    hotkeyController.endCapture()
    globalShortcut.unregisterAll()
    tray.destroy()
  })
}

function startupFailed(error: unknown): void {
  // A tray app: if the startup fails (typically the daemon), there is no window and no tray icon,
  // the process would stay silently dead, and the user would only see that "it does nothing".
  // showErrorBox is synchronous and works without a window, so this is the one place where the
  // error surely reaches the user.
  console.error('[claudeswitcher] startup failed', error)
  dialog.showErrorBox(
    'A ClaudeSwitcher nem tudott elindulni',
    errorMessage(error),
  )
  app.quit()
}

app.on('window-all-closed', () => {
  // A tray app: closing the window does not quit it.
})

// The single `before-quit` handler: the quit sequence (`createQuitSequence`).
app.on('before-quit', quitSequence.onBeforeQuit)
