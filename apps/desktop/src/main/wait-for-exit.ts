/** How often `waitUntil` (and so `waitForExit`) checks. */
export const EXIT_POLL_INTERVAL_MS = 200

/**
 * True while the process exists. Signal 0 only checks: it never touches the process. `EPERM`
 * means it exists but we may not signal it, so it counts as running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

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

/** Waits until `pid` is gone (`waitUntil`). Resolves true when it exited, false on timeout. */
export function waitForExit(
  pid: number,
  timeoutMs: number,
  isRunning: (pid: number) => boolean = isProcessRunning,
): Promise<boolean> {
  return waitUntil(() => !isRunning(pid), timeoutMs)
}
