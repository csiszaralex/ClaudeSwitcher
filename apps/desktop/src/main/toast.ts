import { Notification } from 'electron'
import type { Notice } from './notifier.js'

/**
 * How many shown toasts are kept alive at most. Electron's `Notification` is garbage collected like
 * any object, and a collected one never fires `click`, so every shown toast is held until it is
 * clicked, closed or failed. A toast dismissed on Windows may emit none of these, so the oldest is
 * dropped past this number, which keeps the set bounded.
 */
const MAX_LIVE_TOASTS = 20

/**
 * The function that shows a `Notice` as a Windows toast; a click calls `onActivate` with the
 * session id. Never throws: a failed toast (the system refuses, or notifications are unsupported)
 * is only logged, the tray icon and the list are there anyway.
 */
export function createToaster(onActivate: (sessionId: string) => void): (notice: Notice) => void {
  const live = new Set<Notification>()
  let loggedUnsupported = false

  return (notice) => {
    try {
      if (!Notification.isSupported()) {
        if (!loggedUnsupported) console.warn('[claudeswitcher] toasts are not supported here; no notifications')
        loggedUnsupported = true
        return
      }
      const toast = new Notification({ title: notice.title, body: notice.body })
      const release = (): void => {
        live.delete(toast)
      }
      toast.on('click', () => {
        release()
        onActivate(notice.sessionId)
      })
      toast.on('close', release)
      toast.on('failed', (_event, error) => {
        release()
        console.error(`[claudeswitcher] toast failed: ${error}`)
      })
      live.add(toast)
      for (const old of live) {
        if (live.size <= MAX_LIVE_TOASTS) break
        live.delete(old)
      }
      toast.show()
    } catch (error) {
      console.error('[claudeswitcher] could not show a toast', error)
    }
  }
}
