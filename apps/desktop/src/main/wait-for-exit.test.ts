import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT_POLL_INTERVAL_MS, waitUntil } from './wait-for-exit.js'

describe('waitUntil', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls every 200 ms', () => {
    expect(EXIT_POLL_INTERVAL_MS).toBe(200)
  })

  it('retries the condition until it holds, then stops calling it', async () => {
    // The `--quit` helper's lock request: refused while the primary quits, then granted.
    let calls = 0
    const condition = vi.fn(() => {
      calls += 1
      return calls >= 4
    })
    let result: boolean | undefined
    void waitUntil(condition, 10_000).then((held) => {
      result = held
    })
    await vi.advanceTimersByTimeAsync(EXIT_POLL_INTERVAL_MS * 2)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(EXIT_POLL_INTERVAL_MS * 5)
    expect(result).toBe(true)
    expect(condition).toHaveBeenCalledTimes(4)
  })

  it('resolves false after timeoutMs', async () => {
    let result: boolean | undefined
    void waitUntil(() => false, 1000).then((held) => {
      result = held
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(EXIT_POLL_INTERVAL_MS)
    expect(result).toBe(false)
  })
})
