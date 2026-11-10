import { daemonWsUrl } from '@claudeswitcher/core/browser'
import type { DaemonState } from '@claudeswitcher/daemon'
import { useEffect, useState } from 'react'
import { parseDaemonMessage, sanitizeState } from './state-message.js'

export interface OverlayState extends DaemonState {
  /** False while there is no live connection to the daemon: the list may be stale then. */
  connected: boolean
  /**
   * When the daemon last signalled that it scanned the sessions (`Date.now()`). `undefined` until a
   * signal came. Not the time of the last CHANGE: the daemon does not resend an identical snapshot,
   * so "no change" and "stopped" can be told apart only through this signal.
   */
  checkedAt: number | undefined
  /**
   * The count of applied state messages (a live `state` message or the initial IPC request). From it
   * the top ErrorBoundary knows a new state came and can retry rendering. The heartbeat (`tick`)
   * does not increase it: the same state would fail the same way.
   */
  stateVersion: number
}

/**
 * The wait before the given reconnect attempt. It starts at a quarter second and stops at ten
 * seconds: a machine woken from sleep reconnects fast, but a daemon that stays dead is not hammered.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** Math.max(0, attempt - 1))
}

/** Live state from the daemon's WebSocket hub, with reconnecting. */
export function useDaemonState(): OverlayState {
  const [state, setState] = useState<DaemonState>({ sessions: [], decisions: [] })
  const [connected, setConnected] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | undefined>()
  const [stateVersion, setStateVersion] = useState(0)

  useEffect(() => {
    let socket: WebSocket | undefined
    let closed = false
    const isClosed = (): boolean => closed
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    // Once a live message has arrived, an IPC request that lands later must not overwrite it: the
    // two channels travel separately, with no ordering guarantee between them.
    let receivedLive = false
    // The connection generation. It grows on reconnect, and every handler checks against ITS OWN
    // generation. Without it, a state request started during an earlier, already closed connection
    // could land later than a newer connection's data and overwrite the fresher data. `receivedLive`
    // alone does not protect against this: `onclose` resets it.
    let generation = 0

    const scheduleRetry = (): void => {
      if (closed) return
      attempt += 1
      retry = setTimeout(attemptConnect, retryDelayMs(attempt))
    }

    const connect = async (): Promise<void> => {
      if (closed) return
      const myGeneration = ++generation

      const { port, token } = await window.claudeswitcher.connection()
      // `closed` can change during the `await`; the function call keeps the compiler from taking it
      // as false for good after the earlier `if (closed)`.
      if (isClosed() || myGeneration !== generation) return

      const next = new WebSocket(daemonWsUrl(port, token))
      socket = next

      next.onopen = () => {
        if (closed || myGeneration !== generation) return
        attempt = 0
        setConnected(true)
        // The state is deliberately requested ONLY after the connection opened. A change arriving
        // between a request made before the open and the socket going live would be lost, and since
        // the daemon does not resend identical snapshots, the overlay would stay stale until
        // something changes AGAIN.
        // sanitizeState cannot be left out here either: the IPC path does not go through
        // parseDaemonMessage, so without it only the WebSocket would be protected from a bad shape.
        // The `.catch` is there because an uncaught rejection in the renderer would be silent.
        void window.claudeswitcher
          .state()
          .then((fresh) => {
            const clean = sanitizeState(fresh)
            if (clean === undefined) return
            if (!closed && myGeneration === generation && !receivedLive) {
              setState(clean)
              setStateVersion((version) => version + 1)
            }
          })
          .catch((error: unknown) => {
            console.error('[overlay] could not read the initial state', error)
          })
        // A time-limited test launch looks for this line: the hidden overlay loads its page too, so the
        // line proves that React ran, the IPC answered, and the WebSocket connected with the token.
        // It does not print the token.
        console.info('[overlay] live updates connected')
      }

      next.onmessage = (event) => {
        if (closed || myGeneration !== generation) return
        const parsed = parseDaemonMessage(event.data)
        if (parsed === undefined) return
        // Any message that parses proves the daemon has just scanned.
        setCheckedAt(Date.now())
        if (parsed.kind !== 'state') return
        receivedLive = true
        setState(parsed.state)
        setStateVersion((version) => version + 1)
      }

      next.onclose = () => {
        if (closed || myGeneration !== generation) return
        // After a lost connection the overlay would silently stay stale, and in a monitoring tool
        // that is as bad as wrong data. It reconnects, and meanwhile the user sees that there is no
        // live connection.
        setConnected(false)
        receivedLive = false
        scheduleRetry()
      }

      next.onerror = () => {
        // `close` always follows; the reconnect is scheduled there.
        next.close()
      }
    }

    // EVERY attempt goes through this, the rescheduled ones too. If only the first got a `catch`,
    // the rejection of a later attempt (for example when the IPC does not answer) would stay
    // uncaught, AND the loop would stop silently: no more retries would be scheduled, and the
    // overlay would stay "no connection" forever.
    function attemptConnect(): void {
      connect().catch((error: unknown) => {
        console.error('[overlay] could not reach the daemon', error)
        scheduleRetry()
      })
    }

    attemptConnect()

    return () => {
      closed = true
      if (retry !== undefined) clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return { ...state, connected, checkedAt, stateVersion }
}
