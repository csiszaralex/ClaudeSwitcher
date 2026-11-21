import { useEffect, useRef, useState } from 'react'

/**
 * The order of the replies of one value's requests: each request gets a number when it is sent
 * (`issue`), and its reply is used only if no request sent after it has been used already
 * (`accept`). So a slow reply of an older request (a load on `shown`) never overwrites the fresher
 * one of a later request (the reply of a key the user just pressed).
 */
export function createReplyOrder(): { issue: () => number; accept: (request: number) => boolean } {
  let issued = 0
  let used = 0
  return {
    issue: () => ++issued,
    accept: (request) => {
      if (request <= used) return false
      used = request
      return true
    },
  }
}

/**
 * A value the main process keeps and the overlay shows: `fetch` reads it when the page loads and on
 * every `shown`, and `track` takes the reply of any other request that answers with the same value
 * (a change the user made from the list), so the list redraws at once. Every reply goes through
 * `read`, because anything can come over the IPC. A failed request is only logged with `label`; the
 * value stays as it was.
 */
export function useShownValue<T>(
  fetch: () => Promise<unknown>,
  read: (raw: unknown) => T,
  initial: T,
  label: string,
): [T, (reply: Promise<unknown>) => void] {
  const [value, setValue] = useState<T>(initial)
  const order = useRef(createReplyOrder())
  const closed = useRef(false)

  // Stable for the page's life: `fetch`, `read` and `label` are module-level functions and texts at
  // every call site, so the first ones are the only ones.
  const track = useRef((reply: Promise<unknown>): void => {
    const request = order.current.issue()
    reply
      .then((raw) => {
        if (!closed.current && order.current.accept(request)) setValue(read(raw))
      })
      .catch((error: unknown) => {
        console.error(`[overlay] could not read ${label}`, error)
      })
  })

  useEffect(() => {
    closed.current = false
    const load = (): void => {
      track.current(fetch())
    }
    load()
    const unsubscribe = window.claudeswitcher.onShown(load)
    return () => {
      closed.current = true
      unsubscribe()
    }
  }, [])

  return [value, track.current]
}
