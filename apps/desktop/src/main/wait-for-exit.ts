/** How often `waitUntil` checks. */
export const EXIT_POLL_INTERVAL_MS = 200

/**
 * Waits until `condition` holds, checking at once and then every `EXIT_POLL_INTERVAL_MS`.
 * Resolves true when it held, false when `timeoutMs` passed first.
 */
export function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const check = (): void => {
      if (condition()) {
        resolve(true)
      } else if (Date.now() >= deadline) {
        resolve(false)
      } else {
        setTimeout(check, EXIT_POLL_INTERVAL_MS)
      }
    }
    check()
  })
}
