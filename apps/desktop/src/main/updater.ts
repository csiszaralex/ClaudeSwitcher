/**
 * The in-app update of the installed app, on top of electron-updater's `autoUpdater` (created only
 * when `app.isPackaged`, in `index.ts`; a repo build has no updater at all). It checks at start-up
 * and every `UPDATE_CHECK_INTERVAL_MS` while the `checkForUpdates` setting is on, downloads a new
 * release in the background, and offers it in the tray (`updateLabel`). It installs only on that
 * click, never on its own: the user may be deciding a request.
 */

/** How often the installed app looks for a new release while `checkForUpdates` is on. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The tray line of a downloaded update; clicking it installs the update. */
export function updateLabel(version: string): string {
  return `Frissítés elérhető (${version}), telepítés`
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
  /**
   * Resolves once the check is done. With `autoDownload` the result carries the download
   * (`downloadPromise`), which may still be running and may reject.
   */
  checkForUpdates(): Promise<{ readonly downloadPromise?: Promise<unknown> | null } | null>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdateController {
  /** The `checkForUpdates` setting changed: off stops the checks, on checks now and restarts them. */
  readonly setEnabled: (enabled: boolean) => void
  /** The tray line was clicked: quits and installs the downloaded update. */
  readonly install: () => void
  /** The quit cleanup: no check, no tray update and no install after this. */
  readonly stop: () => void
}

export function createUpdateController(deps: {
  updater: Updater
  /** The `checkForUpdates` setting at start-up. */
  enabled: boolean
  /** An update was downloaded: show `updateLabel(version)` in the tray. */
  onDownloaded: (version: string) => void
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
  let downloaded: string | undefined
  let stopped = false

  // Installing only on the click: a normal quit must not install (`addQuitHandler` in
  // electron-updater's BaseUpdater installs on quit only while `autoInstallOnAppQuit` is on).
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = false
  updater.logger = log
  updater.on('update-downloaded', (info) => {
    downloaded = info.version
    if (!stopped) deps.onDownloaded(info.version)
  })
  // Without a listener the emitter would throw on `error`. Logged only: the next check tries again.
  updater.on('error', (error) => {
    log.error(error)
  })

  /** One check (and its download) at a time; none once an update waits for the click. */
  const check = (): void => {
    if (stopped || checking || downloaded !== undefined) return
    checking = true
    updater
      .checkForUpdates()
      .then((result) => result?.downloadPromise)
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

  let enabled = deps.enabled
  if (enabled) start()

  return {
    setEnabled: (next) => {
      if (stopped || next === enabled) return
      enabled = next
      if (next) start()
      else halt()
    },
    install: () => {
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
    },
    stop: () => {
      stopped = true
      halt()
    },
  }
}
