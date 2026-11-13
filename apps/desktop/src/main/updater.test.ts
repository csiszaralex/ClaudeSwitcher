import { describe, expect, it } from 'vitest'
import {
  UPDATE_CHECK_INTERVAL_MS,
  createUpdateController,
  updateChoice,
  updateLabel,
  updatePrompt,
  type UpdateChoice,
  type Updater,
  type UpdaterLog,
} from './updater.js'

interface Deferred {
  promise: Promise<unknown>
  resolve: (value?: unknown) => void
  reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve: (value?: unknown) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets the promise callbacks of a settled check run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type CheckResult = Awaited<ReturnType<Updater['checkForUpdates']>>

/** What a check that found `version` resolves with. */
const found = (version: string): CheckResult => ({ isUpdateAvailable: true, updateInfo: { version } })
/** What a check that found nothing newer resolves with. */
const upToDate: CheckResult = { isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }

/** A fake `autoUpdater`: every check and every download stays pending until the test settles it. */
function fakeUpdater() {
  const checks: Deferred[] = []
  const downloads: Deferred[] = []
  const installs: [boolean, boolean][] = []
  const listeners: { downloaded?: (info: { version: string }) => void; error?: (error: Error) => void } = {}
  const updater: Updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: null,
    checkForUpdates: () => {
      const check = deferred()
      checks.push(check)
      return check.promise.then((result) => result as CheckResult)
    },
    downloadUpdate: () => {
      const download = deferred()
      downloads.push(download)
      return download.promise
    },
    quitAndInstall: (isSilent, isForceRunAfter) => {
      installs.push([isSilent, isForceRunAfter])
    },
    on: (event: 'update-downloaded' | 'error', listener: ((info: { version: string }) => void) | ((error: Error) => void)) => {
      if (event === 'update-downloaded') listeners.downloaded = listener as (info: { version: string }) => void
      else listeners.error = listener as (error: Error) => void
    },
  }
  return { updater, checks, downloads, installs, listeners }
}

/** A fake `every`: the test fires the interval by hand. */
function fakeEvery() {
  const timers: { fn: () => void; ms: number; stopped: boolean }[] = []
  return {
    timers,
    running: () => timers.filter((timer) => !timer.stopped),
    every: (fn: () => void, ms: number) => {
      const timer = { fn, ms, stopped: false }
      timers.push(timer)
      return () => {
        timer.stopped = true
      }
    },
  }
}

function fakeLog(): UpdaterLog & { errors: unknown[] } {
  const errors: unknown[] = []
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message)
    },
  }
}

/** A fake overlay: the test sets its visibility and hides it. */
function fakeOverlay(visible: boolean) {
  const listeners: (() => void)[] = []
  const overlay = {
    visible,
    hide: () => {
      overlay.visible = false
      for (const listener of listeners) listener()
    },
  }
  return { overlay, listeners }
}

function setup(
  enabled: boolean,
  options: { skippedVersion?: string; overlayVisible?: boolean; saveFails?: boolean } = {},
) {
  const fake = fakeUpdater()
  const timers = fakeEvery()
  const log = fakeLog()
  const { overlay, listeners: hiddenListeners } = fakeOverlay(options.overlayVisible ?? false)
  /** Every `onOffer` call; the last one is what the tray shows. */
  const offers: (string | undefined)[] = []
  /** Every popup shown, with the answer the test gives. */
  const prompts: { version: string; answer: Deferred }[] = []
  const saved: string[] = []
  const controller = createUpdateController({
    updater: fake.updater,
    enabled,
    onOffer: (version) => {
      offers.push(version)
    },
    prompt: (version) => {
      const answer = deferred()
      prompts.push({ version, answer })
      return answer.promise.then((choice) => choice as UpdateChoice)
    },
    overlayVisible: () => overlay.visible,
    onOverlayHidden: (listener) => {
      hiddenListeners.push(listener)
    },
    skippedVersion: options.skippedVersion,
    saveSkipped: (version) => {
      saved.push(version)
      return options.saveFails === true ? Promise.reject(new Error('disk full')) : Promise.resolve(true)
    },
    log,
    every: timers.every,
  })
  return { ...fake, ...timers, log, offers, prompts, saved, overlay, controller }
}

describe('updateLabel', () => {
  it('names the version on the tray line', () => {
    expect(updateLabel('0.2.0')).toBe('Frissítés elérhető (0.2.0), telepítés')
  })
})

describe('updatePrompt', () => {
  it('names both versions and offers the three choices, with "Most ne" as the default and the cancel', () => {
    expect(updatePrompt('0.2.0', '0.1.0')).toEqual({
      type: 'info',
      title: 'Frissítés elérhető',
      message: 'Elérhető a ClaudeSwitcher 0.2.0 (most: 0.1.0).',
      detail: 'A frissítés bezárja és újraindítja az appot. A függő engedélykérések a VS Code-ban megmaradnak.',
      buttons: ['Frissítés most', 'Most ne', 'Verzió kihagyása'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
  })

  it('maps each button to its choice, and any other response to "Most ne"', () => {
    expect([0, 1, 2].map(updateChoice)).toEqual(['install', 'later', 'skip'])
    expect(updateChoice(-1)).toBe('later')
    expect(updateChoice(3)).toBe('later')
  })
})

describe('createUpdateController', () => {
  it('downloads only on its own call, never installs on quit, and logs through the given logger', () => {
    const { updater, log } = setup(false)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.logger).toBe(log)
  })

  it('checks at start-up and every six hours while the setting is on', async () => {
    const { checks, running } = setup(true)
    expect(checks).toHaveLength(1)
    expect(running().map((timer) => timer.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS])
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)

    checks[0]?.resolve(upToDate)
    await settle()
    running()[0]?.fn()
    expect(checks).toHaveLength(2)
  })

  it('does not check at all while the setting is off', () => {
    const { checks, running } = setup(false)
    expect(checks).toHaveLength(0)
    expect(running()).toHaveLength(0)
  })

  it('stops the timer when turned off, and checks now and restarts it when turned on', async () => {
    const { controller, checks, running } = setup(true)
    checks[0]?.resolve(upToDate)
    await settle()

    controller.setEnabled(false)
    expect(running()).toHaveLength(0)

    controller.setEnabled(true)
    expect(checks).toHaveLength(2)
    expect(running()).toHaveLength(1)

    // The same value again changes nothing.
    controller.setEnabled(true)
    expect(checks).toHaveLength(2)
    expect(running()).toHaveLength(1)
  })

  it('downloads a found update, and starts no check while one runs, including its download', async () => {
    const { checks, downloads, running } = setup(true)
    checks[0]?.resolve(found('0.2.0'))
    await settle()
    expect(downloads).toHaveLength(1)
    running()[0]?.fn()
    expect(checks).toHaveLength(1)

    downloads[0]?.resolve([])
    await settle()
    running()[0]?.fn()
    expect(checks).toHaveLength(2)
  })

  it('downloads nothing when the check finds no update or the updater is inactive', async () => {
    const { checks, downloads, running } = setup(true)
    checks[0]?.resolve(upToDate)
    await settle()
    running()[0]?.fn()
    checks[1]?.resolve(null)
    await settle()
    expect(downloads).toHaveLength(0)
  })

  it('logs a rejected check or download and tries again next time, without throwing', async () => {
    const { checks, downloads, running, log } = setup(true)
    checks[0]?.reject(new Error('offline'))
    await settle()
    expect(log.errors).toEqual([new Error('offline')])

    running()[0]?.fn()
    checks[1]?.resolve(found('0.2.0'))
    await settle()
    downloads[0]?.reject(new Error('bad latest.yml'))
    await settle()
    expect(log.errors).toEqual([new Error('offline'), new Error('bad latest.yml')])

    running()[0]?.fn()
    expect(checks).toHaveLength(3)
  })

  it('logs an error event', () => {
    const { listeners, log } = setup(false)
    listeners.error?.(new Error('GitHub down'))
    expect(log.errors).toEqual([new Error('GitHub down')])
  })

  it('offers a downloaded update in the tray, then starts no further check', async () => {
    const { checks, downloads, running, listeners, offers } = setup(true)
    checks[0]?.resolve(found('0.2.0'))
    await settle()
    listeners.downloaded?.({ version: '0.2.0' })
    downloads[0]?.resolve([])
    await settle()
    expect(offers).toEqual(['0.2.0'])

    running()[0]?.fn()
    expect(checks).toHaveLength(1)
  })

  it('installs silently and starts the new version, only after a download', () => {
    const { controller, listeners, installs } = setup(false)
    controller.install()
    expect(installs).toEqual([])

    listeners.downloaded?.({ version: '0.2.0' })
    controller.install()
    expect(installs).toEqual([[true, true]])
  })

  it('after stop: no check, no timer, no tray update and no install', () => {
    const { controller, checks, running, listeners, offers, installs } = setup(true)
    controller.stop()
    expect(running()).toHaveLength(0)

    controller.setEnabled(false)
    controller.setEnabled(true)
    expect(checks).toHaveLength(1)
    expect(running()).toHaveLength(0)

    listeners.downloaded?.({ version: '0.2.0' })
    expect(offers).toEqual([])
    controller.install()
    expect(installs).toEqual([])
  })

  it('starts no download when stopped during the check', async () => {
    const { controller, checks, downloads } = setup(true)
    controller.stop()
    checks[0]?.resolve(found('0.2.0'))
    await settle()
    expect(downloads).toHaveLength(0)
  })
})

describe('the update popup', () => {
  it('shows once a download is ready, once per run per version', async () => {
    const { listeners, prompts } = setup(false)
    listeners.downloaded?.({ version: '0.2.0' })
    expect(prompts.map((prompt) => prompt.version)).toEqual(['0.2.0'])

    prompts[0]?.answer.resolve('later')
    await settle()
    listeners.downloaded?.({ version: '0.2.0' })
    expect(prompts).toHaveLength(1)
  })

  it('"Frissítés most" installs exactly like the tray line', async () => {
    const { listeners, prompts, installs } = setup(false)
    listeners.downloaded?.({ version: '0.2.0' })
    prompts[0]?.answer.resolve('install')
    await settle()
    expect(installs).toEqual([[true, true]])
  })

  it('"Most ne" closes it and keeps the tray line and the install', async () => {
    const { controller, listeners, prompts, offers, installs, saved } = setup(false)
    listeners.downloaded?.({ version: '0.2.0' })
    prompts[0]?.answer.resolve('later')
    await settle()
    expect(offers).toEqual(['0.2.0'])
    expect(installs).toEqual([])
    expect(saved).toEqual([])

    controller.install()
    expect(installs).toEqual([[true, true]])
  })

  it('"Verzió kihagyása" persists the version, removes the tray line and the install, and lets the checks go on', async () => {
    const { controller, checks, downloads, running, listeners, prompts, offers, installs, saved } = setup(true)
    checks[0]?.resolve(found('0.2.0'))
    await settle()
    listeners.downloaded?.({ version: '0.2.0' })
    downloads[0]?.resolve([])
    await settle()
    prompts[0]?.answer.resolve('skip')
    await settle()
    expect(saved).toEqual(['0.2.0'])
    expect(offers).toEqual(['0.2.0', undefined])
    controller.install()
    expect(installs).toEqual([])

    // The next check finds the skipped version again: it is not downloaded.
    running()[0]?.fn()
    expect(checks).toHaveLength(2)
    checks[1]?.resolve(found('0.2.0'))
    await settle()
    expect(downloads).toHaveLength(1)

    // A newer release behaves normally.
    running()[0]?.fn()
    checks[2]?.resolve(found('0.3.0'))
    await settle()
    expect(downloads).toHaveLength(2)
    listeners.downloaded?.({ version: '0.3.0' })
    expect(offers).toEqual(['0.2.0', undefined, '0.3.0'])
    expect(prompts.map((prompt) => prompt.version)).toEqual(['0.2.0', '0.3.0'])
  })

  it('never downloads or offers a version skipped in an earlier run', async () => {
    const { checks, downloads, listeners, prompts, offers, log } = setup(true, { skippedVersion: '0.2.0' })
    checks[0]?.resolve(found('0.2.0'))
    await settle()
    expect(downloads).toHaveLength(0)
    expect(log.errors).toEqual([])

    // Even a download reported anyway shows nothing.
    listeners.downloaded?.({ version: '0.2.0' })
    expect(offers).toEqual([])
    expect(prompts).toHaveLength(0)
  })

  it('waits while the overlay is visible and shows once it hides', () => {
    const { listeners, prompts, offers, overlay } = setup(false, { overlayVisible: true })
    listeners.downloaded?.({ version: '0.2.0' })
    expect(offers).toEqual(['0.2.0'])
    expect(prompts).toHaveLength(0)

    overlay.hide()
    expect(prompts.map((prompt) => prompt.version)).toEqual(['0.2.0'])
    // A later hide does not show it again.
    overlay.hide()
    expect(prompts).toHaveLength(1)
  })

  it('never shows two popups at once: the next one waits for the open one to close', async () => {
    const { listeners, prompts } = setup(false)
    listeners.downloaded?.({ version: '0.2.0' })
    listeners.downloaded?.({ version: '0.3.0' })
    expect(prompts.map((prompt) => prompt.version)).toEqual(['0.2.0'])

    prompts[0]?.answer.resolve('later')
    await settle()
    expect(prompts.map((prompt) => prompt.version)).toEqual(['0.2.0', '0.3.0'])
  })

  it('shows no waiting popup after stop', () => {
    const { controller, listeners, prompts, overlay } = setup(false, { overlayVisible: true })
    listeners.downloaded?.({ version: '0.2.0' })
    controller.stop()
    overlay.hide()
    expect(prompts).toHaveLength(0)
  })

  it('ignores an answer that arrives after stop', async () => {
    const { controller, listeners, prompts, installs, saved } = setup(false)
    listeners.downloaded?.({ version: '0.2.0' })
    controller.stop()
    prompts[0]?.answer.resolve('install')
    await settle()
    expect(installs).toEqual([])
    expect(saved).toEqual([])
  })

  it('logs a failed popup or a failed save, without throwing', async () => {
    const { listeners, prompts, log } = setup(false, { saveFails: true })
    listeners.downloaded?.({ version: '0.2.0' })
    prompts[0]?.answer.reject(new Error('no dialog'))
    await settle()
    expect(log.errors).toEqual([new Error('no dialog')])

    listeners.downloaded?.({ version: '0.3.0' })
    prompts[1]?.answer.resolve('skip')
    await settle()
    expect(log.errors).toEqual([new Error('no dialog'), new Error('disk full')])
  })
})
