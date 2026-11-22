import { isRecord } from '@claudeswitcher/core/browser'
import { useEffect } from 'react'
import { useShownValue } from './useShownValue.js'

/**
 * The sessions in the auto-accept mode and the number of requests the mode allowed for each, from
 * the IPC reply and the push (`OVERLAY_CHANNELS.autoAccept`, `setAutoAccept`, `autoAcceptChanged`):
 * an array of `shared/auto-accept.ts` `AutoAcceptEntry`. Never throws: an entry that is not a
 * non-empty session id with a non-negative whole count drops out, anything else gives an empty map,
 * so the worst case is a row in the mode shown without its colour. The mode itself lives in the main
 * process, which never reads this.
 */
export function readAutoAccept(raw: unknown): ReadonlyMap<string, number> {
  const modes = new Map<string, number>()
  if (!Array.isArray(raw)) return modes
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) continue
    const sessionId = entry['sessionId']
    const allowed = entry['allowed']
    if (typeof sessionId === 'string' && sessionId !== '' && typeof allowed === 'number' && Number.isSafeInteger(allowed) && allowed >= 0) {
      modes.set(sessionId, allowed)
    }
  }
  return modes
}

const NO_MODE: ReadonlyMap<string, number> = new Map()

function fetchAutoAccept(): Promise<unknown> {
  return window.claudeswitcher.autoAccept()
}

/**
 * The sessions in the auto-accept mode, as the main process keeps them (`main/auto-accept.ts`). Read
 * when the page loads and on every `shown`, taken from the reply of a toggle (the returned function,
 * as `useExcludedSessions`), and from every push of the main process, so a count the mode raises
 * while the overlay shows updates at once. A push is the freshest value: it goes through the same
 * reply order (`useShownValue`), so an older reply still in flight cannot overwrite it.
 */
export function useAutoAccept(): [ReadonlyMap<string, number>, (reply: Promise<unknown>) => void] {
  const [modes, track] = useShownValue(fetchAutoAccept, readAutoAccept, NO_MODE, 'the auto-accept sessions')
  useEffect(
    () =>
      window.claudeswitcher.onAutoAcceptChanged((raw) => {
        track(Promise.resolve(raw))
      }),
    [track],
  )
  return [modes, track]
}
