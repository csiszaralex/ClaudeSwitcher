import type { SeenFinishes } from '../shared/session-finished.js'
import { useShownValue } from './useShownValue.js'

/**
 * The seen finishes from the IPC reply (`OVERLAY_CHANNELS.finishesSeen`, `clearFinish`), as main
 * sends them (`shared/session-finished.ts` `seenFinishesReply`): `[sessionId, stoppedAt, cleared]`
 * triples. Never throws: a malformed triple drops out, anything else gives an empty map, so the
 * worst case is a green ✓ that should be blue or gone, in the unseen finishes' group of the list
 * instead of the seen ones' or the idle ones' (`rows.ts` `TONE_RANK`).
 */
export function readSeenFinishes(raw: unknown): SeenFinishes {
  const seen = new Map<string, { stoppedAt: number; cleared: boolean }>()
  if (!Array.isArray(raw)) return seen
  for (const triple of raw as unknown[]) {
    if (!Array.isArray(triple)) continue
    const [sessionId, stoppedAt, cleared] = triple as unknown[]
    if (typeof sessionId === 'string' && typeof stoppedAt === 'number' && typeof cleared === 'boolean') {
      seen.set(sessionId, { stoppedAt, cleared })
    }
  }
  return seen
}

const NONE_SEEN: SeenFinishes = new Map()

function fetchSeenFinishes(): Promise<unknown> {
  return window.claudeswitcher.finishesSeen()
}

/**
 * The finishes the user has seen, as the main process keeps them (`acknowledgeFinish`,
 * `clearFinish`). Read when the page loads and on every `shown`: the main process acknowledges a
 * finish only while the overlay is hidden, after hiding it when the user opens the session from the
 * overlay (`focusSession`), and never while it is visible when the session's VS Code tab is in front
 * (`watchSeen` in `main/index.ts`), so the next time the list is visible it has the fresh map. The
 * one change made while the list shows, a cleared ✓ (Backspace), answers with the whole map: App
 * passes that reply to the returned function, so the row redraws at once.
 */
export function useSeenFinishes(): [SeenFinishes, (reply: Promise<unknown>) => void] {
  return useShownValue(fetchSeenFinishes, readSeenFinishes, NONE_SEEN, 'the seen finishes')
}
