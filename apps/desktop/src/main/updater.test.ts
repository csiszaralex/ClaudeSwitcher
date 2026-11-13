import { describe, expect, it } from 'vitest'
import { UPDATE_CHECK_INTERVAL_MS, createUpdateController, updateLabel, type Updater, type UpdaterLog } from './updater.js'

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

/** A fake `autoUpdater`: every check stays pending until the test settles it. */
function fakeUpdater() {
  const checks: Deferred[] = []
  const installs: [boolean, boolean][] = []
  const listeners: { downloaded?: (info: { version: string }) => void; error?: (error: Error) => void } = {}
  const updater: Updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: null,
    checkForUpdates: () => {
      const check = deferred()
      checks.push(check)
      return check.promise.then((result) => result as { downloadPromise?: Promise<unknown> | null } | null)
    },
    quitAndInstall: (isSilent, isForceRunAfter) => {
      installs.push([isSilent, isForceRunAfter])
    },
    on: (event: 'update-downloaded' | 'error', listener: ((info: { version: string }) => void) | ((error: Error) => void)) => {
      if (event === 'update-downloaded') listeners.downloaded = listener as (info: { version: string }) => void
      else listeners.error = listener as (error: Error) => void
    },
  }
  return { updater, checks, installs, listeners }
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

function setup(enabled: boolean) {
  const fake = fakeUpdater()
  const timers = fakeEvery()
  const log = fakeLog()
  const downloaded: string[] = []
  const controller = createUpdateController({
    updater: fake.updater,
    enabled,
    onDownloaded: (version) => {
      downloaded.push(version)
    },
    log,
    every: timers.every,
  })
  return { ...fake, ...timers, log, downloaded, controller }
}

describe('updateLabel', () => {
  it('names the version on the tray line', () => {
    expect(updateLabel('0.2.0')).toBe('Frissítés elérhető (0.2.0), telepítés')
  })
})

describe('createUpdateController', () => {
  it('downloads automatically, never installs on quit, and logs through the given logger', () => {
    const { updater, log } = setup(false)
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.logger).toBe(log)
  })

  it('checks at start-up and every six hours while the setting is on', async () => {
    const { checks, running } = setup(true)
    expect(checks).toHaveLength(1)
    expect(running().map((timer) => timer.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS])
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)

    checks[0]?.resolve(null)
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
    checks[0]?.resolve(null)
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

  it('starts no check while one runs, including its download', async () => {
    const { checks, running } = setup(true)
    const download = deferred()
    checks[0]?.resolve({ downloadPromise: download.promise })
    await settle()
    running()[0]?.fn()
    expect(checks).toHaveLength(1)

    download.resolve([])
    await settle()
    running()[0]?.fn()
    expect(checks).toHaveLength(2)
  })

  it('logs a rejected check or download and tries again next time, without throwing', async () => {
    const { checks, running, log } = setup(true)
    checks[0]?.reject(new Error('offline'))
    await settle()
    expect(log.errors).toEqual([new Error('offline')])

    running()[0]?.fn()
    checks[1]?.resolve({ downloadPromise: Promise.reject(new Error('bad latest.yml')) })
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

  it('offers a downloaded update, then skips further checks', async () => {
    const { checks, running, listeners, downloaded } = setup(true)
    listeners.downloaded?.({ version: '0.2.0' })
    checks[0]?.resolve({ downloadPromise: Promise.resolve([]) })
    await settle()
    expect(downloaded).toEqual(['0.2.0'])

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
    const { controller, checks, running, listeners, downloaded, installs } = setup(true)
    controller.stop()
    expect(running()).toHaveLength(0)

    controller.setEnabled(false)
    controller.setEnabled(true)
    expect(checks).toHaveLength(1)
    expect(running()).toHaveLength(0)

    listeners.downloaded?.({ version: '0.2.0' })
    expect(downloaded).toEqual([])
    controller.install()
    expect(installs).toEqual([])
  })
})
