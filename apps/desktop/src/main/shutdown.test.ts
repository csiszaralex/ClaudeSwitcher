import { describe, expect, it, vi } from 'vitest'
import { STOP_TIMEOUT_MS, stopWithin } from './shutdown.js'

describe('stopWithin', () => {
  it('reports a stop that finishes in time', async () => {
    await expect(stopWithin(() => Promise.resolve(), 1000)).resolves.toBe(true)
  })

  it('gives up after the timeout instead of hanging the quit', async () => {
    const started = Date.now()
    await expect(stopWithin(() => new Promise<void>(() => undefined), 50)).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('treats a failing stop as finished, never as a reason to stay alive', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(stopWithin(() => Promise.reject(new Error('boom')), 1000)).resolves.toBe(false)
    logged.mockRestore()
  })

  it('waits STOP_TIMEOUT_MS by default', async () => {
    vi.useFakeTimers()
    try {
      let result: boolean | undefined
      void stopWithin(() => new Promise<void>(() => undefined)).then((inTime) => {
        result = inTime
      })
      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS - 1)
      expect(result).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(result).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
