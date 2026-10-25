import { describe, expect, it } from 'vitest'
import { createReloadLimiter } from './reload-limit.js'

describe('createReloadLimiter', () => {
  it('allows the first reloads, then refuses within the same window', () => {
    let clock = 0
    const allow = createReloadLimiter({ limit: 3, windowMs: 60_000, now: () => clock })
    expect([allow(), allow(), allow()]).toEqual([true, true, true])
    clock = 59_999
    expect(allow()).toBe(false)
  })

  it('allows again once the oldest reload has left the window', () => {
    let clock = 0
    const allow = createReloadLimiter({ limit: 3, windowMs: 60_000, now: () => clock })
    allow()
    clock = 10_000
    allow()
    clock = 20_000
    allow()
    clock = 60_000
    // A 0-s újratöltés kiesett az ablakból, a 10 s-os és a 20 s-os még benne van.
    expect(allow()).toBe(true)
    expect(allow()).toBe(false)
  })

  it('does not count refused attempts, so a crash loop cannot keep the window closed for ever', () => {
    let clock = 0
    const allow = createReloadLimiter({ limit: 1, windowMs: 60_000, now: () => clock })
    expect(allow()).toBe(true)
    clock = 30_000
    expect(allow()).toBe(false)
    clock = 60_000
    expect(allow()).toBe(true)
  })
})
