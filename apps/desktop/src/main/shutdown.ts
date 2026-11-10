/** How long quitting waits for the daemon to stop. Plenty to send the empty 200s. */
export const STOP_TIMEOUT_MS = 2000

/**
 * Stops the daemon within at most `timeoutMs`. Returns true if the stop completed in time, false if
 * the time ran out or the stop threw. Quitting must not get stuck in either case: the connections
 * of the held requests die with the process anyway, and Claude Code, as measured, takes that as "no
 * decision" (design doc, section 8).
 */
export async function stopWithin(stop: () => Promise<void>, timeoutMs: number = STOP_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false)
    }, timeoutMs)
  })
  const stopped = stop().then(
    () => true,
    (error: unknown) => {
      console.error('[claudeswitcher] daemon stop failed', error)
      return false
    },
  )
  try {
    return await Promise.race([stopped, expired])
  } finally {
    clearTimeout(timer)
  }
}
