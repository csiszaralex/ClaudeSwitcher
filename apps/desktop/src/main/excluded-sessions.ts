import type { SessionStatus } from '@claudeswitcher/core'
import type { ExcludedEntry, ExcludedReply } from '../shared/excluded-sessions.js'

/**
 * How long an excluded session must be missing from the daemon's live sessions, without a break,
 * before its id is dropped from the excluded list, or its returned mark ends
 * (`createExcludedSessions` `observe`). A bound, not a measurement: far longer than any gap the
 * daemon's own picture can have while the session lives (a scan, every `POLL_INTERVAL_MS`, that
 * could not read the session's registry file), and long enough that a session whose process comes
 * back under the same id (a VS Code window reloaded) keeps its place.
 */
export const EXCLUDED_GONE_AFTER_MS = 10 * 60_000

/** The part of a session the excluded list reads; the daemon's `SessionView` fits it. */
interface LiveSession {
  sessionId: string
  status: SessionStatus
}

export interface ExcludedSessionsOptions {
  /** The entries stored in `config.json` (`main/config.ts` `StoredConfig.excludedSessions`). */
  initial: readonly ExcludedEntry[]
  /** Stores the whole list after every change of it (`main/config.ts` `saveExcludedSessions`). */
  persist: (entries: readonly ExcludedEntry[]) => void
  /** Writes one line to the log: a session that came back because it started running. */
  log: (line: string) => void
}

export interface ExcludedSessions {
  /** The excluded sessions and the returned ones: the IPC reply and the push. */
  reply(): ExcludedReply
  /** The excluded session ids, for the tray and the notifier. A returned session is not among them. */
  set(): ReadonlySet<string>
  /**
   * Excludes a session, but only one of the live `sessions` the caller read from the daemon now, so
   * a row without a session, or a session that ended since the key was pressed, is not excluded. It
   * remembers how: excluded while its turn is in progress (`status` not `idle`, so `working` or
   * `waiting`), it stays out when it runs again (`whileRunning`); excluded while `idle`, it comes
   * back once it starts running (`observe`). Ends the session's returned mark. True when the list or
   * the mark changed; excluding an excluded session again changes nothing.
   */
  exclude(sessionId: string, sessions: readonly LiveSession[]): boolean
  /** Brings a session back; true when the list changed, so a second press changes nothing. */
  include(sessionId: string): boolean
  /**
   * Ends the session's returned mark: the user jumped to it from the overlay. True when it had one.
   */
  acknowledgeReturn(sessionId: string): boolean
  /**
   * From the live `sessions` at `now`, called with every tray tick: brings back each session
   * excluded while idle that is running now (not `idle`), with the returned mark; and drops the
   * excluded ids and the returned marks whose session is gone (see the module's
   * `EXCLUDED_GONE_AFTER_MS`). True when the list or the returned marks changed.
   */
  observe(sessions: readonly LiveSession[], now: number): boolean
}

/**
 * The sessions the user moved out of the list (Delete on a row), kept across restarts in
 * `config.json`, and the ones that came back by themselves because they started running (the
 * returned marks, in memory only: after a restart no row carries one). Every change is checked
 * against the state the caller passes, not the state the renderer saw, and is idempotent, so a key
 * pressed twice within a moment does no harm.
 *
 * When an id counts as gone: the daemon lists only live sessions (`running.state().sessions`), and
 * nothing in its state says whether that picture is complete. Before its first successful scan the
 * list is empty, and so it is after a scan whose process probe has no snapshot yet (every session
 * counts as dead then) or whose registry folder could not be read; and a scan drops a session whose
 * registry file it cannot read or parse at that moment (daemon `scanner.ts` `readRecords`). So an id
 * (excluded or returned) is dropped only after its session has been missing for
 * `EXCLUDED_GONE_AFTER_MS` without a break, and only while the daemon lists at least one session: an
 * empty list is no picture, and it restarts every count. A session that comes back within that time
 * keeps its place. Dropping an id too early only brings a session back into the list; keeping a
 * stale id could hide a later session that resumes the same id.
 */
export function createExcludedSessions(options: ExcludedSessionsOptions): ExcludedSessions {
  // Session id to `whileRunning`, in the order they were excluded.
  const excluded = new Map(options.initial.map((entry) => [entry.sessionId, entry.whileRunning]))
  const returned = new Set<string>()
  // Since when each excluded or returned session has been missing from a non-empty live list.
  const missingSince = new Map<string, number>()

  const entries = (): ExcludedEntry[] => [...excluded].map(([sessionId, whileRunning]) => ({ sessionId, whileRunning }))
  const persist = (): void => {
    options.persist(entries())
  }
  /** Whether the id, missing from the live list now, has been missing long enough to be dropped. */
  const goneFor = (id: string, now: number): boolean => {
    const since = missingSince.get(id)
    if (since === undefined) {
      missingSince.set(id, now)
      return false
    }
    if (now - since < EXCLUDED_GONE_AFTER_MS) return false
    missingSince.delete(id)
    return true
  }

  return {
    reply: () => ({ excluded: entries(), returned: [...returned] }),
    set: () => new Set(excluded.keys()),
    exclude(sessionId, sessions) {
      const session = sessions.find((s) => s.sessionId === sessionId)
      if (excluded.has(sessionId) || session === undefined) return false
      excluded.set(sessionId, session.status !== 'idle')
      // Its absence counts from here on, not from a returned mark's.
      returned.delete(sessionId)
      missingSince.delete(sessionId)
      persist()
      return true
    },
    include(sessionId) {
      if (!excluded.delete(sessionId)) return false
      missingSince.delete(sessionId)
      persist()
      return true
    },
    acknowledgeReturn(sessionId) {
      if (!returned.delete(sessionId)) return false
      missingSince.delete(sessionId)
      return true
    },
    observe(sessions, now) {
      if (sessions.length === 0) {
        missingSince.clear()
        return false
      }
      const live = new Map(sessions.map((s) => [s.sessionId, s]))
      let listChanged = false
      let marksChanged = false
      for (const [id, whileRunning] of excluded) {
        const session = live.get(id)
        if (session === undefined) {
          if (goneFor(id, now)) {
            excluded.delete(id)
            listChanged = true
          }
          continue
        }
        missingSince.delete(id)
        if (!whileRunning && session.status !== 'idle') {
          excluded.delete(id)
          returned.add(id)
          listChanged = true
          marksChanged = true
          options.log(`[claudeswitcher] excluded session ${id} started running: back in the list`)
        }
      }
      for (const id of returned) {
        if (live.has(id)) missingSince.delete(id)
        else if (goneFor(id, now)) {
          returned.delete(id)
          marksChanged = true
        }
      }
      if (listChanged) persist()
      return listChanged || marksChanged
    },
  }
}
