import { useEffect, useState } from 'react'
import type { SeenFinishes } from '../shared/session-finished.js'

/**
 * The seen finishes from the IPC reply (`OVERLAY_CHANNELS.finishesSeen`): `[sessionId, stoppedAt]`
 * pairs. Never throws: a malformed pair drops out, anything else gives an empty map, so the worst
 * case is a green ✓ that should be blue, in the unseen finishes' group of the list instead of the
 * seen ones' (`rows.ts` `TONE_RANK`).
 */
export function readSeenFinishes(raw: unknown): SeenFinishes {
  const seen = new Map<string, number>()
  if (!Array.isArray(raw)) return seen
  for (const pair of raw as unknown[]) {
    if (!Array.isArray(pair)) continue
    const [sessionId, stoppedAt] = pair as unknown[]
    if (typeof sessionId === 'string' && typeof stoppedAt === 'number') seen.set(sessionId, stoppedAt)
  }
  return seen
}

/**
 * The finishes the user has seen, as the main process keeps them (`acknowledgeFinish`). Read when
 * the page loads and on every `shown`: the main process records a finish only when the user opens
 * the session from the overlay (`focusSession`), and only after hiding the overlay, so the next
 * time the list is visible it has the fresh map.
 */
export function useSeenFinishes(): SeenFinishes {
  const [seen, setSeen] = useState<SeenFinishes>(() => new Map())

  useEffect(() => {
    let closed = false
    const load = (): void => {
      window.claudeswitcher
        .finishesSeen()
        .then((raw) => {
          if (!closed) setSeen(readSeenFinishes(raw))
        })
        .catch((error: unknown) => {
          console.error('[overlay] could not read the seen finishes', error)
        })
    }
    load()
    const unsubscribe = window.claudeswitcher.onShown(load)
    return () => {
      closed = true
      unsubscribe()
    }
  }, [])

  return seen
}
