import { describe, expect, it } from 'vitest'
import { RateLimitStore } from './rate-limits.js'

const NOW = 1_000_000

describe('RateLimitStore', () => {
  it('starts empty', () => {
    expect(new RateLimitStore().current(NOW)).toEqual({})
  })

  it('keeps the most recent update', () => {
    const store = new RateLimitStore()
    store.update({ five_hour: { used_percentage: 10, resets_at: NOW / 1000 + 100 } })
    store.update({ five_hour: { used_percentage: 20, resets_at: NOW / 1000 + 100 } })
    expect(store.current(NOW).five_hour?.used_percentage).toBe(20)
  })

  it('merges windows reported in separate updates', () => {
    const store = new RateLimitStore()
    store.update({ five_hour: { used_percentage: 10, resets_at: NOW / 1000 + 100 } })
    store.update({ seven_day: { used_percentage: 40, resets_at: NOW / 1000 + 200 } })
    const current = store.current(NOW)
    expect(current.five_hour?.used_percentage).toBe(10)
    expect(current.seven_day?.used_percentage).toBe(40)
  })

  it('drops a window once its resets_at has passed', () => {
    // A Claude Code maga is eldobja a lejárt ablakot; a UI ne mutasson állottat.
    const store = new RateLimitStore()
    store.update({ five_hour: { used_percentage: 90, resets_at: NOW / 1000 - 1 } })
    expect(store.current(NOW).five_hour).toBeUndefined()
  })
})
