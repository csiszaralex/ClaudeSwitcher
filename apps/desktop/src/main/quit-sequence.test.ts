import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuitSequence } from './quit-sequence.js'

/** A `before-quit` event that records whether it was prevented. */
function quitEvent(): { preventDefault: () => void; prevented: () => boolean } {
  let prevented = false
  return {
    preventDefault: () => {
      prevented = true
    },
    prevented: () => prevented,
  }
}

/** A stop the test resolves by hand, with the order of every step recorded in `steps`. */
function harness() {
  const steps: string[] = []
  let finishStop: (inTime: boolean) => void = () => undefined
  const stopWithin = vi.fn((stop: () => Promise<void>) => {
    void stop()
    return new Promise<boolean>((resolve) => {
      finishStop = (inTime) => {
        steps.push(inTime ? 'stopped' : 'timed out')
        resolve(inTime)
      }
    })
  })
  const sequence = createQuitSequence({
    quit: () => {
      steps.push('quit')
    },
    stopWithin,
    // Asynchronous like the real removal, so a quit that does not wait for it lands first.
    removeRecord: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      steps.push('remove record')
    },
  })
  const daemon = {
    stop: vi.fn(() => {
      steps.push('stop')
      return Promise.resolve()
    }),
  }
  return {
    steps,
    sequence,
    stopWithin,
    daemon,
    finishStop: (inTime: boolean) => {
      finishStop(inTime)
    },
  }
}

/** Lets the sequence's promise chain, the record removal's macrotask included, run to its end. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createQuitSequence', () => {
  it('prevents the first before-quit and quits after the daemon stopped', async () => {
    const { steps, sequence, daemon, finishStop } = harness()
    sequence.setDaemon(daemon)
    const event = quitEvent()

    expect(sequence.isQuitting()).toBe(false)
    sequence.onBeforeQuit(event)

    expect(event.prevented()).toBe(true)
    expect(sequence.isQuitting()).toBe(true)
    await settle()
    expect(steps).toEqual(['stop'])
    finishStop(true)
    await settle()
    expect(steps).toEqual(['stop', 'stopped', 'remove record', 'quit'])
  })

  it('swallows a second before-quit while stopping', async () => {
    const { steps, sequence, stopWithin, daemon, finishStop } = harness()
    sequence.setDaemon(daemon)
    sequence.onBeforeQuit(quitEvent())
    const second = quitEvent()

    sequence.onBeforeQuit(second)

    expect(second.prevented()).toBe(true)
    expect(stopWithin).toHaveBeenCalledTimes(1)
    expect(daemon.stop).toHaveBeenCalledTimes(1)
    finishStop(true)
    await settle()
    expect(steps.filter((step) => step === 'quit')).toHaveLength(1)
  })

  it('lets before-quit through once done', async () => {
    const { sequence, stopWithin, daemon, finishStop } = harness()
    sequence.setDaemon(daemon)
    sequence.onBeforeQuit(quitEvent())
    finishStop(true)
    await settle()
    const own = quitEvent()

    sequence.onBeforeQuit(own)

    expect(own.prevented()).toBe(false)
    expect(sequence.isQuitting()).toBe(true)
    expect(stopWithin).toHaveBeenCalledTimes(1)
  })

  it('removes the record only after the stop resolved or timed out', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const inTime of [true, false]) {
      const { steps, sequence, daemon, finishStop } = harness()
      sequence.setDaemon(daemon)
      sequence.onBeforeQuit(quitEvent())
      await settle()
      expect(steps).not.toContain('remove record')

      finishStop(inTime)
      await settle()

      expect(steps).toEqual(['stop', inTime ? 'stopped' : 'timed out', 'remove record', 'quit'])
    }
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('[claudeswitcher] daemon did not stop in time; quitting anyway')
  })

  it('still stops and quits when cleanup throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { steps, sequence, daemon, finishStop } = harness()
    sequence.setDaemon(daemon)
    sequence.setCleanup(() => {
      steps.push('cleanup')
      throw new Error('tray already gone')
    })
    const event = quitEvent()

    sequence.onBeforeQuit(event)
    finishStop(true)
    await settle()

    expect(event.prevented()).toBe(true)
    expect(steps).toEqual(['cleanup', 'stop', 'stopped', 'remove record', 'quit'])
    expect(logged).toHaveBeenCalledWith('[claudeswitcher] cleanup failed', expect.any(Error))
  })

  it('quits without a daemon when none was set', async () => {
    const { steps, sequence, stopWithin } = harness()
    const event = quitEvent()

    sequence.onBeforeQuit(event)
    await settle()

    expect(event.prevented()).toBe(true)
    expect(stopWithin).not.toHaveBeenCalled()
    expect(steps).toEqual(['remove record', 'quit'])
  })
})
