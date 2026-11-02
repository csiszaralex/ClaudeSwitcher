/**
 * The app's quit: Electron does not wait for the asynchronous daemon `stop()`, so held requests
 * could die without their empty 200s. The first `before-quit` is therefore prevented: the sequence
 * releases the hotkey and the tray (`cleanup`), waits for the daemon (`stopWithin`), removes the
 * instance record, and only then quits for real. A second `before-quit` (from that own `quit()`,
 * or an impatient second request) starts no second stop.
 */
export interface QuitSequence {
  /** True from the first `before-quit` on. A function, so a check after an `await` is not narrowed away. */
  readonly isQuitting: () => boolean
  /** Set once `startApp` has a running daemon; until then the quit stops none. */
  readonly setDaemon: (daemon: { stop(): Promise<void> }) => void
  /** Set once `startApp` holds a hotkey and a tray to release; until then it is a no-op. */
  readonly setCleanup: (cleanup: () => void) => void
  /** The `before-quit` handler body; a property, so it can be passed to `app.on` unbound. */
  readonly onBeforeQuit: (event: { preventDefault(): void }) => void
}

export function createQuitSequence(deps: {
  /** Quits for real (`app.quit()`); the `before-quit` it triggers is let through. */
  quit: () => void
  /** Stops the daemon within a time limit; false when the limit passed or the stop failed. */
  stopWithin: (stop: () => Promise<void>) => Promise<boolean>
  /** Removes this instance's record: a no-op until the record was written. */
  removeRecord: () => Promise<void>
}): QuitSequence {
  let state: 'no' | 'stopping' | 'done' = 'no'
  let daemon: { stop(): Promise<void> } | undefined
  let cleanup: () => void = () => undefined

  return {
    isQuitting: () => state !== 'no',
    setDaemon: (running) => {
      daemon = running
    },
    setCleanup: (release) => {
      cleanup = release
    },
    onBeforeQuit: (event) => {
      if (state === 'done') return
      event.preventDefault()
      if (state === 'stopping') return
      state = 'stopping'
      // A failing cleanup must not block the quit: the daemon stop and the quit still run.
      try {
        cleanup()
      } catch (error) {
        console.error('[claudeswitcher] cleanup failed', error)
      }
      const running = daemon
      const stopped = running === undefined ? Promise.resolve(true) : deps.stopWithin(() => running.stop())
      void stopped.then(async (inTime) => {
        if (!inTime) console.error('[claudeswitcher] daemon did not stop in time; quitting anyway')
        // After the daemon released the port: a build waiting for this pid may start once it is gone.
        await deps.removeRecord()
        state = 'done'
        deps.quit()
      })
    },
  }
}
