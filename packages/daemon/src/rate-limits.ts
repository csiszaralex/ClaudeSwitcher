import type { RateLimits } from '@claudeswitcher/core'

/**
 * Account-szintű adat, ezért bármelyik session statusLine-ja frissítheti.
 * A lejárt ablakokat eldobjuk — a Claude Code is ezt teszi, és állott
 * százalékot mutatni rosszabb, mint semmit.
 */
export class RateLimitStore {
  #limits: RateLimits = {}

  update(limits: RateLimits): void {
    this.#limits = { ...this.#limits, ...limits }
  }

  current(now: number = Date.now()): RateLimits {
    const seconds = now / 1000
    const out: RateLimits = {}
    for (const key of ['five_hour', 'seven_day', 'spend_limit'] as const) {
      const window = this.#limits[key]
      if (window !== undefined && window.resets_at > seconds) out[key] = window
    }
    return out
  }
}
