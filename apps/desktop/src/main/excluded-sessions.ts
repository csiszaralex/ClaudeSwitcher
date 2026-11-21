/**
 * How long an excluded session must be missing from the daemon's live sessions, without a break,
 * before its id is dropped from the excluded list (`createExcludedSessions` `observe`). A bound, not
 * a measurement: far longer than any gap the daemon's own picture can have while the session lives
 * (a scan, every `POLL_INTERVAL_MS`, that could not read the session's registry file), and long enough that a
 * session whose process comes back under the same id (a VS Code window reloaded) keeps its place.
 */
export const EXCLUDED_GONE_AFTER_MS = 10 * 60_000

/** The part of a session the excluded list reads; the daemon's `SessionView` fits it. */
interface LiveSession {
  sessionId: string
}

export interface ExcludedSessionsOptions {
  /** The ids stored in `config.json` (`main/config.ts` `StoredConfig.excludedSessions`). */
  initial: readonly string[]
  /** Stores the whole list after every change (`main/config.ts` `saveExcludedSessions`). */
  persist: (ids: readonly string[]) => void
}

export interface ExcludedSessions {
  /** The excluded session ids, in the order they were excluded: the IPC reply. */
  ids(): string[]
  /** The excluded session ids, for the tray and the notifier. */
  set(): ReadonlySet<string>
  /**
   * Excludes a session, but only one of the live `sessions` the caller read from the daemon now, so
   * a row without a session, or a session that ended since the key was pressed, is not excluded.
   * True when the list changed; excluding an excluded session again changes nothing.
   */
  exclude(sessionId: string, sessions: readonly LiveSession[]): boolean
  /** Brings a session back; true when the list changed, so a second press changes nothing. */
  include(sessionId: string): boolean
  /**
   * Drops the ids whose session is gone (see the module's `EXCLUDED_GONE_AFTER_MS`), from the live
   * `sessions` at `now`. Called with every tray tick. True when the list changed.
   */
  observe(sessions: readonly LiveSession[], now: number): boolean
}

/**
 * The sessions the user moved out of the list (Delete on a row), kept across restarts in
 * `config.json`. Every change is checked against the state the caller passes, not the state the
 * renderer saw, and is idempotent, so a key pressed twice within a moment does no harm.
 *
 * When an id counts as gone: the daemon lists only live sessions (`running.state().sessions`), and
 * nothing in its state says whether that picture is complete. Before its first successful scan the
 * list is empty, and so it is after a scan whose process probe has no snapshot yet (every session
 * counts as dead then) or whose registry folder could not be read; and a scan drops a session whose
 * registry file it cannot read or parse at that moment (daemon `scanner.ts` `readRecords`). So an id is dropped only after its session has been
 * missing for `EXCLUDED_GONE_AFTER_MS` without a break, and only while the daemon lists at least one
 * session: an empty list is no picture, and it restarts every count. A session that comes back
 * within that time keeps its place. Dropping an id too early only brings a session back into the
 * list; keeping a stale id could hide a later session that resumes the same id.
 */
export function createExcludedSessions(options: ExcludedSessionsOptions): ExcludedSessions {
  const excluded = new Set(options.initial)
  // Since when each excluded session has been missing from a non-empty live list.
  const missingSince = new Map<string, number>()

  const changed = (): true => {
    options.persist([...excluded])
    return true
  }

  return {
    ids: () => [...excluded],
    set: () => excluded,
    exclude(sessionId, sessions) {
      if (excluded.has(sessionId) || !sessions.some((s) => s.sessionId === sessionId)) return false
      excluded.add(sessionId)
      return changed()
    },
    include(sessionId) {
      missingSince.delete(sessionId)
      if (!excluded.delete(sessionId)) return false
      return changed()
    },
    observe(sessions, now) {
      if (sessions.length === 0) {
        missingSince.clear()
        return false
      }
      const live = new Set(sessions.map((s) => s.sessionId))
      let dropped = false
      for (const id of excluded) {
        if (live.has(id)) {
          missingSince.delete(id)
          continue
        }
        const since = missingSince.get(id)
        if (since === undefined) {
          missingSince.set(id, now)
        } else if (now - since >= EXCLUDED_GONE_AFTER_MS) {
          excluded.delete(id)
          missingSince.delete(id)
          dropped = true
        }
      }
      return dropped && changed()
    },
  }
}
