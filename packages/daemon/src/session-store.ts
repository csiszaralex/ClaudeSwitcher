import type { LiveSession, SessionActivity, SessionView } from '@claudeswitcher/core'
import type { LifecycleEvent, NotificationEvent } from './hook-server.js'

/**
 * Meddig tartunk meg egy olyan várakozást, aminek a sessionje még nem szerepel a
 * pillanatképben. Bőven több, mint a 3 másodperces poll — de nem végtelen, hogy egy soha
 * meg nem jelenő session ne szivárogjon.
 */
const UNMATCHED_WAIT_GRACE_MS = 10_000

const WAITING_TYPES = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])

interface WaitState {
  since: number
  text?: string | undefined
}

function displayName(record: LiveSession['record']): string {
  if (record.name !== undefined && record.name !== '') return record.name
  const parts = record.cwd.split(/[\\/]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? record.sessionId
}

/**
 * A UI-nak küldött állapot egyetlen forrása. Három bemenetet egyesít:
 * a periodikus snapshotot (registry + transcript), a hook-eseményeket, és az
 * életciklus-eseményeket. Ütközésnél a hook nyer: a snapshot a transcriptből
 * származik és lemaradhat, a hook viszont a történés pillanatában érkezik.
 */
export class SessionStore {
  #sessions = new Map<string, LiveSession>()
  #activities = new Map<string, SessionActivity>()
  #waiting = new Map<string, WaitState>()
  #listeners: Array<() => void> = []

  onChange(listener: () => void): void {
    this.#listeners.push(listener)
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[store] listener failed', error)
      }
    }
  }

  applySnapshot(
    sessions: LiveSession[],
    activities: Map<string, SessionActivity>,
    now: number = Date.now(),
  ): void {
    const ids = new Set(sessions.map((s) => s.record.sessionId))
    this.#sessions = new Map(sessions.map((s) => [s.record.sessionId, s]))
    this.#activities = activities

    for (const [id, wait] of [...this.#waiting]) {
      if (ids.has(id)) continue
      // Egy FRISS várakozást nem dobunk el csak azért, mert a session még nem került be a
      // registry-be: a hook azonnal megérkezik, a registry-t viszont csak pár másodpercenként
      // olvassuk. A türelmi idő után viszont takarítunk, különben egy soha meg nem jelenő
      // session várakozása örökre a memóriában maradna.
      if (now - wait.since < UNMATCHED_WAIT_GRACE_MS) continue
      this.#waiting.delete(id)
    }
    this.#emit()
  }

  /**
   * Akkor is eltárolja a várakozást, ha a session még ismeretlen.
   *
   * A `views()` a sessionökön iterál, tehát egy párját nem talált bejegyzés láthatatlan —
   * viszont amint a következő pillanatkép felveszi a sessiont, azonnal `waiting`-ként
   * jelenik meg. Korábban az ilyen értesítés VÉGLEGESEN elveszett, és a felhasználó egy rá
   * várakozó sessiont látott idle-ként.
   */
  applyNotification(event: NotificationEvent, now: number = Date.now()): void {
    if (WAITING_TYPES.has(event.type)) {
      this.#waiting.set(event.sessionId, { since: now, text: event.text })
    } else {
      this.#waiting.delete(event.sessionId)
    }
    this.#emit()
  }

  applyLifecycle(event: LifecycleEvent): void {
    if (event.kind === 'end') {
      this.#sessions.delete(event.sessionId)
    }
    this.#waiting.delete(event.sessionId)
    this.#emit()
  }

  views(): SessionView[] {
    const views: SessionView[] = []

    for (const [sessionId, session] of this.#sessions) {
      const activity = this.#activities.get(sessionId) ?? {}
      const wait = this.#waiting.get(sessionId)

      const status =
        wait !== undefined ? 'waiting'
        : activity.runningTool !== undefined ? 'working'
        : 'idle'

      views.push({
        sessionId,
        pid: session.record.pid,
        name: displayName(session.record),
        cwd: session.record.cwd,
        status,
        activity,
        windowPid: session.window?.pid,
        workspaceFolder: session.window?.workspaceFolders[0],
        bridgeSessionId: session.record.bridgeSessionId,
        waitingSince: wait?.since,
        notificationText: wait?.text,
      })
    }

    return views.sort((a, b) => {
      if (a.status === 'waiting' && b.status !== 'waiting') return -1
      if (b.status === 'waiting' && a.status !== 'waiting') return 1
      if (a.status === 'waiting' && b.status === 'waiting') {
        return (a.waitingSince ?? 0) - (b.waitingSince ?? 0)
      }
      return a.name.localeCompare(b.name)
    })
  }
}
