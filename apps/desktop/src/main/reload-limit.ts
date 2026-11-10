/** At most this many renderer reloads within `RELOAD_WINDOW_MS`. */
export const RELOAD_LIMIT = 3
export const RELOAD_WINDOW_MS = 60_000

export interface ReloadLimiterOptions {
  limit?: number | undefined
  windowMs?: number | undefined
  /** The clock, so the sliding window can be tested. */
  now?: (() => number) | undefined
}

/**
 * A sliding-window limit on reloading the overlay renderer. Returns true if the reload still fits,
 * and then records it.
 *
 * Without a limit, a renderer that always crashes on load (for example OOM on a huge state) would
 * fall into a tight crash and reload loop, which burns CPU and floods the log. A refused attempt
 * does not count towards the window, so the limit allows again at the latest `windowMs` after the
 * last allowed reloads (the overlay's `show` in `createOverlayController` then retries on the next
 * opening).
 */
export function createReloadLimiter(options: ReloadLimiterOptions = {}): () => boolean {
  const limit = options.limit ?? RELOAD_LIMIT
  const windowMs = options.windowMs ?? RELOAD_WINDOW_MS
  const now = options.now ?? (() => Date.now())
  let reloads: number[] = []
  return () => {
    const at = now()
    reloads = reloads.filter((t) => at - t < windowMs)
    if (reloads.length >= limit) return false
    reloads.push(at)
    return true
  }
}
