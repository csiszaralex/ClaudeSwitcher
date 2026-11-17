/**
 * The in-app update of the installed app, on top of electron-updater's `autoUpdater` (created only
 * when `app.isPackaged`, in `index.ts`; a repo build has no updater at all). It checks at start-up
 * and every `UPDATE_CHECK_INTERVAL_MS` while the `checkForUpdates` setting is on, downloads a new
 * release in the background unless the user skipped that version, and offers it in the tray's
 * update item (`UpdateItem`) and once per run in a popup (`updatePrompt`). It installs only on the
 * user's choice, never on its own: the user may be deciding a request. Without a download on offer
 * the same item checks on the user's request (`checkNow`), whatever the setting.
 */

/** How often the installed app looks for a new release while `checkForUpdates` is on. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * The tray's one update item: `check` offers a manual check (`checkNow`), `busy` while that check
 * (or its download) runs, `install` a downloaded update on offer, which its click installs
 * (`install`). The controller alone decides it (`onItem`), so the label and the click agree.
 */
export type UpdateItem =
  | { readonly kind: 'check' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'install'; readonly version: string }

/**
 * The Hungarian definite article before `version` read aloud: "az" when the spoken number starts
 * with a vowel, else "a". The major version decides. Hungarian reads a number in groups of three
 * digits, so its first word comes from the leading group: a leading group of exactly 1 is "egy"
 * (1, "egymillió") or "ezer" (1000..1999), and one that starts with 5 is "öt", "ötven…" or
 * "ötszáz…"; every other first word ("nulla", "kettő", "tíz", "tizen…", "száz", …) starts with a
 * consonant. A version without a leading number gets "a".
 */
export function versionArticle(version: string): 'a' | 'az' {
  const major = /^\d+/.exec(version)?.[0].replace(/^0+(?=\d)/, '')
  if (major === undefined) return 'a'
  const leadingGroup = major.slice(0, ((major.length - 1) % 3) + 1)
  return leadingGroup === '1' || leadingGroup.startsWith('5') ? 'az' : 'a'
}

/**
 * The label of the tray's update item. Not "Frissítések keresése": that is the label of the
 * `checkForUpdates` toggle in the same menu.
 */
export function updateItemLabel(item: UpdateItem): string {
  switch (item.kind) {
    case 'check':
      return 'Frissítés keresése most'
    case 'busy':
      return 'Frissítés keresése…'
    case 'install':
      return `Frissítés ${versionArticle(item.version)} ${item.version} verzióra`
  }
}

/** The answer to a manual check that has nothing to offer: `latest` (nothing newer) or `failed`. */
export type UpdateNotice = 'latest' | 'failed'

/** The box of an `UpdateNotice` as `dialog.showMessageBox` options (the part of `MessageBoxOptions` it sets). */
export interface UpdateNoticeOptions {
  type: 'info' | 'warning'
  title: string
  message: string
}

/** The box answering a manual check; `currentVersion` is this app's version. */
export function updateNotice(notice: UpdateNotice, currentVersion: string): UpdateNoticeOptions {
  return notice === 'latest'
    ? { type: 'info', title: 'ClaudeSwitcher', message: `A legfrissebb verzió fut (${currentVersion}).` }
    : { type: 'warning', title: 'ClaudeSwitcher', message: 'Nem sikerült ellenőrizni a frissítést. Részletek a naplóban.' }
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
  /** The update item's `install` (or "Frissítés most" in the popup): quits and installs the downloaded update. */
  readonly install: () => void
  /**
   * The update item's `check`: a check now, whatever the setting, that offers a skipped version
   * too. It ends in the popup or in an `UpdateNotice` box. A click on a menu shown before a
   * download landed opens that download's popup again instead.
   */
  readonly checkNow: () => void
  /** The quit cleanup: no check, no download, no item change, no popup, no box and no install after this. */
  readonly stop: () => void
}

/**
 * How a check (with its download) ended: `downloaded` (on offer), `none` (nothing newer), `skipped`
 * (it found the skipped version and left it), `failed` (logged), or `stopped` (quit meanwhile).
 */
type CheckOutcome = 'downloaded' | 'none' | 'skipped' | 'failed' | 'stopped'

export function createUpdateController(deps: {
  updater: Updater
  /** The `checkForUpdates` setting at start-up. */
  enabled: boolean
  /** Shows the update popup (`updatePrompt`) and resolves with the user's choice. */
  prompt: (version: string) => Promise<UpdateChoice>
  /** Shows the box of a manual check (`updateNotice`); resolves once it is closed. */
  notify: (notice: UpdateNotice) => Promise<unknown>
  /** The tray's update item changed (`updateItemLabel`); called with `check` at creation, then on each change. */
  onItem: (item: UpdateItem) => void
  /**
   * Whether the overlay is visible. The overlay hides on blur, so a popup or box taking the focus
   * would close it while the user decides a request: they wait until the overlay is hidden.
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
  /** The check (and its download) running now: one at a time, automatic or manual. */
  let running: Promise<CheckOutcome> | undefined
  /**
   * The downloaded version on offer (the `install` item, `install`). A skipped version is on offer only
   * after a manual check downloaded it.
   */
  let downloaded: string | undefined
  let skipped = deps.skippedVersion
  /** The skipped version a manual check downloads now: `update-downloaded` offers it all the same. */
  let offeringSkipped: string | undefined
  let stopped = false
  /** The versions this run has queued a popup for: on its own, one popup per run per version. */
  const prompted = new Set<string>()
  /** The version whose popup waits for the overlay to hide or for the open dialog to close. */
  let pendingPrompt: string | undefined
  /** The manual check's box, waiting the same way. */
  let pendingNotice: UpdateNotice | undefined
  /** The version of the open popup, while the open dialog is the popup. */
  let openPrompt: string | undefined
  let dialogOpen = false
  let manualBusy = false
  /** The item the tray shows (`JSON.stringify` of it), so an unchanged one is not sent again. */
  let shownItem: string | undefined

  /**
   * Sends the item the state gives, if it changed: a running manual check first, then a download on
   * offer. Never throws: a throwing `onItem` is logged and `shownItem` stays as it was, so the next
   * call sends the item again.
   */
  function showItem(): void {
    const item: UpdateItem = manualBusy
      ? { kind: 'busy' }
      : downloaded !== undefined
        ? { kind: 'install', version: downloaded }
        : { kind: 'check' }
    const key = JSON.stringify(item)
    if (key === shownItem) return
    try {
      deps.onItem(item)
    } catch (error: unknown) {
      log.error(error)
      return
    }
    shownItem = key
  }

  // Installing only on the user's choice: a normal quit must not install (`addQuitHandler` in
  // electron-updater's BaseUpdater installs on quit only while `autoInstallOnAppQuit` is on).
  // No automatic download either: `check` downloads only a version that is not skipped.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.logger = log
  updater.on('update-downloaded', (info) => {
    if (stopped || (info.version === skipped && info.version !== offeringSkipped)) return
    downloaded = info.version
    log.info(`update ${info.version} downloaded`)
    showItem()
    if (prompted.has(info.version)) return
    prompted.add(info.version)
    pendingPrompt = info.version
    showNext()
  })
  // Without a listener the emitter would throw on `error`. Logged only: the next check tries again.
  updater.on('error', (error) => {
    log.error(error)
  })
  deps.onOverlayHidden(() => {
    showNext()
  })

  /**
   * Shows the waiting dialog, the popup before a box: one dialog at a time, never while the overlay
   * is visible, none after stop.
   */
  function showNext(): void {
    if (stopped || dialogOpen || deps.overlayVisible()) return
    if (pendingPrompt !== undefined) showPrompt(pendingPrompt)
    else if (pendingNotice !== undefined) showNotice(pendingNotice)
  }

  function showPrompt(version: string): void {
    pendingPrompt = undefined
    dialogOpen = true
    openPrompt = version
    // Called at once, but a synchronous throw becomes a rejection: otherwise `dialogOpen` would
    // stay true and no dialog could show again in this run.
    new Promise<UpdateChoice>((resolve) => {
      resolve(deps.prompt(version))
    })
      .then((choice) => {
        if (stopped) return
        switch (choice) {
          case 'install':
            install()
            break
          case 'later':
            // The `install` item stays for this run. After a restart, the start-up check (only
            // while `checkForUpdates` is on) offers the version again, item and popup:
            // electron-updater reports the cached download again
            // (`DownloadedUpdateHelper.validateDownloadedPath`). A skipped version that a manual
            // check offered is the exception: the start-up check leaves it (`checkAndDownload`),
            // so only a manual check offers it again.
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
        dialogOpen = false
        openPrompt = undefined
        showNext()
      })
  }

  function showNotice(notice: UpdateNotice): void {
    pendingNotice = undefined
    dialogOpen = true
    // As in `showPrompt`: a synchronous throw must not leave `dialogOpen` set.
    new Promise<unknown>((resolve) => {
      resolve(deps.notify(notice))
    })
      .catch((error: unknown) => {
        log.error(error)
      })
      .finally(() => {
        dialogOpen = false
        showNext()
      })
  }

  /**
   * Skips `version`: its `install` item goes, and the automatic checks never download or offer it again
   * (a manual check still does). Skipping the skipped version again saves nothing.
   */
  function skip(version: string): void {
    log.info(`skipping version ${version}`)
    if (skipped !== version) {
      skipped = version
      deps.saveSkipped(version).catch((error: unknown) => {
        log.error(error)
      })
    }
    if (downloaded === version) {
      downloaded = undefined
      showItem()
    }
  }

  /** Runs `work` as the one running check; a rejection is logged and ends as `failed`. */
  function track(work: () => Promise<CheckOutcome>): Promise<CheckOutcome> {
    const run: Promise<CheckOutcome> = work()
      .catch((error: unknown): CheckOutcome => {
        log.error(error)
        return 'failed'
      })
      .finally(() => {
        if (running === run) running = undefined
      })
    running = run
    return run
  }

  /** A check and the download of what it found; `offerSkipped` (a manual check) downloads a skipped version too. */
  async function checkAndDownload(offerSkipped: boolean): Promise<CheckOutcome> {
    const result = await updater.checkForUpdates()
    if (stopped) return 'stopped'
    if (result === null) {
      log.warn('the updater is inactive; nothing was checked')
      return 'failed'
    }
    if (!result.isUpdateAvailable) return 'none'
    const { version } = result.updateInfo
    if (version === skipped && !offerSkipped) {
      log.info(`version ${version} is skipped; not downloading it`)
      return 'skipped'
    }
    return download(version)
  }

  /** Downloads `version`, the one the last check found. */
  async function download(version: string): Promise<CheckOutcome> {
    if (version === skipped) offeringSkipped = version
    try {
      await updater.downloadUpdate()
    } finally {
      offeringSkipped = undefined
    }
    if (stopped) return 'stopped'
    // electron-updater 6.8.11 emits `update-downloaded` before `downloadUpdate` resolves: BaseUpdater
    // `executeDownload` dispatches it in the `done` that AppUpdater `executeDownload` awaits, for a
    // cached download as for a fresh one. So the version is on offer by now.
    if (downloaded === version) return 'downloaded'
    log.warn(`the download of ${version} finished without an update-downloaded event`)
    return 'failed'
  }

  /**
   * The automatic check: one check (and its download) at a time; none while a downloaded update
   * waits for the user. A skipped update is not on offer, so the checks go on and find the next release.
   */
  const check = (): void => {
    if (stopped || running !== undefined || downloaded !== undefined) return
    void track(() => checkAndDownload(false))
  }

  /**
   * The manual check's outcome. An automatic check running now is joined, not doubled: its outcome
   * counts, except that a skipped version it left is downloaded now (the user asked).
   */
  async function manualOutcome(): Promise<CheckOutcome> {
    if (running === undefined) return track(() => checkAndDownload(true))
    const joined = await running
    if (joined !== 'skipped' || stopped || skipped === undefined) return joined
    const version = skipped
    return track(() => download(version))
  }

  /** Queues the popup of `version` again, unless it is open or already waiting. */
  function promptAgain(version: string): void {
    if (openPrompt === version || pendingPrompt === version) return
    prompted.add(version)
    pendingPrompt = version
    showNext()
  }

  /** Queues the box of `notice`; one manual check at a time, so at most one waits. */
  function showNoticeLater(notice: UpdateNotice): void {
    pendingNotice = notice
    showNext()
  }

  function checkNow(): void {
    if (stopped || manualBusy) return
    if (downloaded !== undefined) {
      promptAgain(downloaded)
      return
    }
    manualBusy = true
    showItem()
    void manualOutcome()
      .then((outcome) => {
        manualBusy = false
        if (stopped) return
        showItem()
        switch (outcome) {
          case 'downloaded':
            // `update-downloaded` queued the popup already, unless this run showed it before.
            if (downloaded !== undefined) promptAgain(downloaded)
            break
          case 'none':
            showNoticeLater('latest')
            break
          // A manual check downloads a skipped version, so `skipped` does not reach here; if it
          // did, the user would still get an answer.
          case 'skipped':
          case 'failed':
            showNoticeLater('failed')
            break
          case 'stopped':
            break
        }
      })
      .catch((error: unknown) => {
        // `showItem` catches a throwing `onItem`, and `showPrompt` and `showNotice` their own
        // dialog's throw; what is left (a throwing `overlayVisible`) comes after `manualBusy` was
        // cleared and the item sent, so the next click checks again. Logged only.
        log.error(error)
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

  showItem()
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
    checkNow,
    stop: () => {
      stopped = true
      pendingPrompt = undefined
      pendingNotice = undefined
      halt()
    },
  }
}
