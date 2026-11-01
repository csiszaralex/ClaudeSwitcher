import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT_POLL_INTERVAL_MS, isProcessRunning, waitForExit, waitUntil } from './wait-for-exit.js'

describe('waitForExit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls every 200 ms', () => {
    expect(EXIT_POLL_INTERVAL_MS).toBe(200)
  })

  it('resolves true once isRunning turns false', async () => {
    let alive = true
    const isRunning = vi.fn(() => alive)
    let result: boolean | undefined
    void waitForExit(4242, 10_000, isRunning).then((exited) => {
      result = exited
    })
    await vi.advanceTimersByTimeAsync(EXIT_POLL_INTERVAL_MS * 3)
    expect(result).toBeUndefined()
    alive = false
    await vi.advanceTimersByTimeAsync(EXIT_POLL_INTERVAL_MS)
    expect(result).toBe(true)
    expect(isRunning).toHaveBeenCalledWith(4242)
  })

  it('resolves false after timeoutMs', async () => {
    let result: boolean | undefined
    void waitForExit(4242, 1000, () => true).then((exited) => {
      result = exited
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(EXIT_POLL_INTERVAL_MS)
    expect(result).toBe(false)
  })

  it('checks immediately, so an already dead pid resolves without waiting', async () => {
    let result: boolean | undefined
    void waitForExit(4242, 10_000, () => false).then((exited) => {
      result = exited
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe(true)
  })
})

describe('waitUntil', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
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

describe('isProcessRunning', () => {
  it('sees this process as running', () => {
    expect(isProcessRunning(process.pid)).toBe(true)
  })

  it('counts EPERM as running: the process exists, only signalling it is refused', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    try {
      expect(isProcessRunning(4242)).toBe(true)
    } finally {
      kill.mockRestore()
    }
  })

  it('counts ESRCH as gone', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    try {
      expect(isProcessRunning(4242)).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })
})
