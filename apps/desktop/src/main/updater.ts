/**
 * The in-app update of the installed app, on top of electron-updater's `autoUpdater` (created only
 * when `app.isPackaged`, in `index.ts`; a repo build has no updater at all). It checks at start-up
 * and every `UPDATE_CHECK_INTERVAL_MS` while the `checkForUpdates` setting is on, downloads a new
 * release in the background unless the user skipped that version, and offers it in the tray
 * (`updateLabel`) and once per run in a popup (`updatePrompt`). It installs only on the user's
 * choice, never on its own: the user may be deciding a request.
 */

/** How often the installed app looks for a new release while `checkForUpdates` is on. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The tray line of a downloaded update; clicking it installs the update. */
export function updateLabel(version: string): string {
  return `Frissítés elérhető (${version}), telepítés`
}

/** What the user chose in the update popup. */
export type UpdateChoice = 'install' | 'later' | 'skip'

/** The popup's buttons, in display order. */
const PROMPT_BUTTONS: readonly { readonly choice: UpdateChoice; readonly label: string }[] = [
  { choice: 'install', label: 'Frissítés most' },
  { choice: 'later', label: 'Most ne' },
  { choice: 'skip', label: 'Verzió kihagyása' },
]

/** The safe choice: a stray Enter or closing the popup never restarts the app. */
const PROMPT_SAFE_CHOICE: UpdateChoice = 'later'

/** The update popup as `dialog.showMessageBox` options (the part of `MessageBoxOptions` it sets). */
export interface UpdatePromptOptions {
  type: 'info'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

/** The popup offering a downloaded update: `newVersion` is the download, `currentVersion` this app. */
export function updatePrompt(newVersion: string, currentVersion: string): UpdatePromptOptions {
  const safe = PROMPT_BUTTONS.findIndex((button) => button.choice === PROMPT_SAFE_CHOICE)
  return {
    type: 'info',
    title: 'Frissítés elérhető',
    message: `Elérhető a ClaudeSwitcher ${newVersion} (most: ${currentVersion}).`,
    detail: 'A frissítés bezárja és újraindítja az appot. A függő engedélykérések a VS Code-ban megmaradnak.',
    buttons: PROMPT_BUTTONS.map((button) => button.label),
    defaultId: safe,
    cancelId: safe,
    noLink: true,
  }
}

/** The choice behind the button index `dialog.showMessageBox` resolves with; any other index is the safe one. */
export function updateChoice(response: number): UpdateChoice {
  return PROMPT_BUTTONS[response]?.choice ?? PROMPT_SAFE_CHOICE
}

/** The logger shape electron-updater accepts (its `Logger`), and the one the controller logs to. */
export interface UpdaterLog {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
}

/** electron-updater's own messages and the controller's errors, on the console with our prefix. */
export const CONSOLE_UPDATER_LOG: UpdaterLog = {
  info: (message) => {
    console.log('[claudeswitcher] updater:', message)
  },
  warn: (message) => {
    console.warn('[claudeswitcher] updater:', message)
  },
  error: (message) => {
    console.error('[claudeswitcher] updater:', message)
  },
}

/** The part of electron-updater's `AppUpdater` (`NsisUpdater` on Windows) this module uses. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: UpdaterLog | null
  /** Resolves once the check is done; `null` while the updater is inactive (not packaged). */
  checkForUpdates(): Promise<{ readonly isUpdateAvailable: boolean; readonly updateInfo: { readonly version: string } } | null>
  /** Downloads the update the last check found; rejects if the download fails. */
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdateController {
  /** The `checkForUpdates` setting changed: off stops the checks, on checks now and restarts them. */
  readonly setEnabled: (enabled: boolean) => void
  /** The tray line (or "Frissítés most" in the popup): quits and installs the downloaded update. */
  readonly install: () => void
  /** The quit cleanup: no check, no download, no tray update, no popup and no install after this. */
  readonly stop: () => void
}

export function createUpdateController(deps: {
  updater: Updater
  /** The `checkForUpdates` setting at start-up. */
  enabled: boolean
  /**
   * The update on offer changed: a downloaded version shows `updateLabel(version)` in the tray,
   * `undefined` (the user skipped it) removes the line.
   */
  onOffer: (version: string | undefined) => void
  /** Shows the update popup (`updatePrompt`) and resolves with the user's choice. */
  prompt: (version: string) => Promise<UpdateChoice>
  /**
   * Whether the overlay is visible. The overlay hides on blur, so a popup taking the focus would
   * close it while the user decides a request: the popup waits until the overlay is hidden.
   */
  overlayVisible: () => boolean
  /** Registers a listener for the overlay being hidden. */
  onOverlayHidden: (listener: () => void) => void
  /** The version skipped at start-up (`StoredConfig.skippedVersion`). */
  skippedVersion: string | undefined
  /** Persists a newly skipped version (`saveSkippedVersion`). It stays skipped for this run either way. */
  saveSkipped: (version: string) => Promise<unknown>
  log: UpdaterLog
  /** Runs `fn` every `ms`; returns the stop. `setInterval`, unref'd, unless a test replaces it. */
  every?: (fn: () => void, ms: number) => () => void
}): UpdateController {
  const { updater, log } = deps
  const every =
    deps.every ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setInterval(fn, ms)
      timer.unref()
      return () => {
        clearInterval(timer)
      }
    })

  let stopTimer: (() => void) | undefined
  let checking = false
  /** The downloaded version on offer (the tray line, `install`). A skipped version is never on offer. */
  let downloaded: string | undefined
  let skipped = deps.skippedVersion
  let stopped = false
  /** The versions this run has queued a popup for: one popup per run per version. */
  const prompted = new Set<string>()
  /** The version whose popup waits for the overlay to hide or for the open popup to close. */
  let pendingPrompt: string | undefined
  let prompting = false

  // Installing only on the user's choice: a normal quit must not install (`addQuitHandler` in
  // electron-updater's BaseUpdater installs on quit only while `autoInstallOnAppQuit` is on).
  // No automatic download either: `check` downloads only a version that is not skipped.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.logger = log
  updater.on('update-downloaded', (info) => {
    if (stopped || info.version === skipped) return
    downloaded = info.version
    deps.onOffer(info.version)
    if (prompted.has(info.version)) return
    prompted.add(info.version)
    pendingPrompt = info.version
    showPrompt()
  })
  // Without a listener the emitter would throw on `error`. Logged only: the next check tries again.
  updater.on('error', (error) => {
    log.error(error)
  })
  deps.onOverlayHidden(() => {
    showPrompt()
  })

  /** Shows the waiting popup: one at a time, never while the overlay is visible, none after stop. */
  function showPrompt(): void {
    if (stopped || prompting || pendingPrompt === undefined || deps.overlayVisible()) return
    const version = pendingPrompt
    pendingPrompt = undefined
    prompting = true
    deps
      .prompt(version)
      .then((choice) => {
        if (stopped) return
        switch (choice) {
          case 'install':
            install()
            break
          case 'later':
            // The tray line stays. electron-updater reports the cached download again after the
            // next start's check (`DownloadedUpdateHelper.validateDownloadedPath`), so the popup
            // comes back then.
            break
          case 'skip':
            skip(version)
            break
        }
      })
      .catch((error: unknown) => {
        log.error(error)
      })
      .finally(() => {
        prompting = false
        showPrompt()
      })
  }

  /** Skips `version`: its tray line goes, and it is never downloaded or offered again. */
  function skip(version: string): void {
    skipped = version
    log.info(`skipping version ${version}`)
    deps.saveSkipped(version).catch((error: unknown) => {
      log.error(error)
    })
    if (downloaded === version) {
      downloaded = undefined
      deps.onOffer(undefined)
    }
  }

  /**
   * One check (and its download) at a time; none while a downloaded update waits for the user. A
   * skipped update is not on offer, so the checks go on and find the next release.
   */
  const check = (): void => {
    if (stopped || checking || downloaded !== undefined) return
    checking = true
    updater
      .checkForUpdates()
      .then((result) => {
        if (stopped || result === null || !result.isUpdateAvailable) return
        const { version } = result.updateInfo
        if (version === skipped) {
          log.info(`version ${version} is skipped; not downloading it`)
          return
        }
        return updater.downloadUpdate()
      })
      .catch((error: unknown) => {
        log.error(error)
      })
      .finally(() => {
        checking = false
      })
  }

  const start = (): void => {
    check()
    stopTimer ??= every(check, UPDATE_CHECK_INTERVAL_MS)
  }
  const halt = (): void => {
    stopTimer?.()
    stopTimer = undefined
  }

  function install(): void {
    if (stopped || downloaded === undefined) return
    // `quitAndInstall(true, true)`: a silent install that starts the new version afterwards.
    // Checked against electron-updater 6.8.11 and our installer:
    // - BaseUpdater `quitAndInstall` first starts the installer (NsisUpdater `doInstall` spawns it
    //   detached with `--updated /S --force-run`), then calls `app.quit()` on the next tick. That
    //   is a normal quit: our single `before-quit` handler (`createQuitSequence`) prevents it,
    //   runs the cleanup (which stops this controller), lets the daemon release the held
    //   requests within `STOP_TIMEOUT_MS`, and only then quits for real.
    // - The installer's `customCheckAppRunning` (resources/installer.nsh) runs the installed exe
    //   with `--quit` (`csRunHelper`). That helper asks this app to quit (already quitting: the
    //   request is ignored by `before-quit`) and exits once it holds the single-instance lock,
    //   which Electron releases during our quit, after the daemon stopped (`runHelper`,
    //   `closeRunningApp`, within `HANDOVER_TIMEOUT_MS`). No deadlock: our quit never waits for
    //   the installer. Only a quit slower than `HANDOVER_TIMEOUT_MS` would make the silent
    //   installer give up (`csRunHelper`'s MessageBox defaults to Cancel with /SD).
    // - The old uninstaller runs with `--updated` (`uninstallOldVersion`), so `customUnInstall`
    //   keeps the integration, autostart and shortcuts (`isUpdated`). After a silent install,
    //   `--force-run` starts the new version (installSection.nsh `doStartApp`).
    updater.quitAndInstall(true, true)
  }

  let enabled = deps.enabled
  if (enabled) start()

  return {
    setEnabled: (next) => {
      if (stopped || next === enabled) return
      enabled = next
      if (next) start()
      else halt()
    },
    install,
    stop: () => {
      stopped = true
      pendingPrompt = undefined
      halt()
    },
  }
}
