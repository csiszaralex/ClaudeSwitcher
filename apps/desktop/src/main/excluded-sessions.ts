import type { SessionStatus } from '@claudeswitcher/core'
import type { DueEntry, ExcludedEntry, ExcludedReply, WeeklyReset } from '../shared/excluded-sessions.js'

/**
 * How long an excluded session must be missing from the daemon's live sessions, without a break,
 * before its id is dropped from the excluded list, or its returned or due mark ends
 * (`createExcludedSessions` `observe`). A bound, not a measurement: far longer than any gap the
 * daemon's own picture can have while the session lives (a scan, every `POLL_INTERVAL_MS`, that
 * could not read the session's registry file), and long enough that a session whose process comes
 * back under the same id (a VS Code window reloaded) keeps its place. A session excluded until a
 * time is not dropped by it before that time.
 */
export const EXCLUDED_GONE_AFTER_MS = 10 * 60_000

/** The part of a session the excluded list reads; the daemon's `SessionView` fits it. */
interface LiveSession {
  sessionId: string
  status: SessionStatus
  /** The end of its last turn (epoch ms), for `quietFinishes`. */
  stoppedAt?: number | undefined
}

/** What `config.json` keeps of the excluded list: its `excludedSessions` and `dueSessions` keys. */
export interface StoredExclusions {
  excluded: readonly ExcludedEntry[]
  due: readonly DueEntry[]
}

export interface ExcludedSessionsOptions {
  /** The entries stored in `config.json` (`main/config.ts` `StoredConfig.excludedSessions`). */
  initial: readonly ExcludedEntry[]
  /** The due marks stored in `config.json` (`main/config.ts` `StoredConfig.dueSessions`). */
  initialDue: readonly DueEntry[]
  /** The weekly reset from `config.json` (`main/config.ts` `StoredConfig.weeklyReset`), passed on to the overlay. */
  weeklyReset: WeeklyReset | undefined
  /**
   * Stores the whole list and the due marks after every change of either, in one write
   * (`main/config.ts` `saveExcludedSessions`).
   */
  persist: (stored: StoredExclusions) => void
  /** Writes one line to the log: a session that came back because it started running, or because its time passed. */
  log: (line: string) => void
}

export interface ExcludedSessions {
  /** The excluded, the returned and the due sessions, and the weekly reset: the IPC reply and the push. */
  reply(): ExcludedReply
  /**
   * The sessions whose finish stays quiet in the tray and the toasts (`main/tray-state.ts`,
   * `main/notifier.ts`): every excluded session, and a due one whose last finish (`stoppedAt`) is
   * not later than its time, so the return itself colours nothing. A finish after the time counts
   * as any session's.
   */
  quietFinishes(sessions: readonly LiveSession[]): ReadonlySet<string>
  /**
   * Excludes a session, but only one of the live `sessions` the caller read from the daemon now, so
   * a row without a session, or a session that ended since the key was pressed, is not excluded. It
   * remembers how: excluded while its turn is in progress (`status` not `idle`, so `working` or
   * `waiting`), it stays out when it runs again (`whileRunning`); excluded while `idle`, it comes
   * back once it starts running (`observe`). Ends the session's returned and due marks. True when
   * the list or a mark changed; excluding an excluded session again changes nothing.
   */
  exclude(sessionId: string, sessions: readonly LiveSession[]): boolean
  /**
   * Excludes a session until `until` (epoch ms, Shift+Delete), or sets a new time for one excluded
   * already (its `whileRunning` stays). Refuses (false, nothing changes) an `until` that is not a
   * finite number or not after `now`, so a misread time never hides a session; it is IPC input,
   * hence `unknown`. A session not excluded yet must be one of the live `sessions`, as for
   * `exclude`, and loses its returned and due marks. True when anything changed.
   */
  excludeUntil(sessionId: string, until: unknown, sessions: readonly LiveSession[], now: number): boolean
  /** Brings a session back, its time dropped; true when the list changed, so a second press changes nothing. */
  include(sessionId: string): boolean
  /** Ends the session's returned and due marks: the user jumped to it from the overlay. True when it had one. */
  acknowledgeReturn(sessionId: string): boolean
  /** Ends the session's due mark only: Backspace on its row. True when it had one. */
  clearDue(sessionId: string): boolean
  /**
   * From the live `sessions` at `now`, called with every tray tick: turns each exclusion whose time
   * has passed into a due mark, live or not, whatever the list says (an empty or partial list is no
   * proof the session is gone, so the time alone decides); brings back each session excluded while
   * idle that is running now (not `idle`), with the returned mark and without its time; and drops
   * the excluded ids without a time and the returned and due marks whose session is gone (see the
   * module's `EXCLUDED_GONE_AFTER_MS`). True when the list or a mark changed.
   */
  observe(sessions: readonly LiveSession[], now: number): boolean
}

/** One excluded session's fields besides its id. */
interface Exclusion {
  whileRunning: boolean
  until: number | undefined
}

/** The entry of the wire and the file, with `until` only when there is one. */
function entryOf(sessionId: string, { whileRunning, until }: Exclusion): ExcludedEntry {
  return until === undefined ? { sessionId, whileRunning } : { sessionId, whileRunning, until }
}

/** Whether `until` is a time a session can be excluded until: a finite number after `now`. */
function isFutureTime(until: unknown, now: number): until is number {
  return typeof until === 'number' && Number.isFinite(until) && until > now
}

/**
 * The sessions the user moved out of the list (Delete on a row, or Shift+Delete with a time), kept
 * across restarts in `config.json`; the ones that came back by themselves because they started
 * running (the returned marks, in memory only: after a restart no row carries one); and the ones
 * whose time passed (the due marks, kept in `config.json` too: the time may pass while the app is
 * off, and the mark must still show after the next start). Every change is checked against the
 * state the caller passes, not the state the renderer saw, and is idempotent, so a key pressed
 * twice within a moment does no harm.
 *
 * When an id counts as gone: the daemon lists only live sessions (`running.state().sessions`), and
 * nothing in its state says whether that picture is complete. Before its first successful scan the
 * list is empty, and so it is after a scan whose process probe has no snapshot yet (every session
 * counts as dead then) or whose registry folder could not be read; and a scan drops a session whose
 * registry file it cannot read or parse at that moment (daemon `scanner.ts` `readRecords`). So an id
 * (excluded, returned or due) is dropped only after its session has been missing for
 * `EXCLUDED_GONE_AFTER_MS` without a break, and only while the daemon lists at least one session: an
 * empty list is no picture, and it restarts every count. A session that comes back within that time
 * keeps its place. Dropping an id too early only brings a session back into the list; keeping a
 * stale id could hide a later session that resumes the same id. A session excluded until a time is
 * never dropped before that time: its window may stay closed until then (VS Code closed over the
 * weekend). At the time it turns into a due mark, which the same rule drops if it is really gone.
 */
export function createExcludedSessions(options: ExcludedSessionsOptions): ExcludedSessions {
  // Session id to its exclusion, in the order they were excluded.
  const excluded = new Map<string, Exclusion>(
    options.initial.map((entry) => [entry.sessionId, { whileRunning: entry.whileRunning, until: entry.until }]),
  )
  const returned = new Set<string>()
  // Session id to the time it was excluded until.
  const due = new Map<string, number>(options.initialDue.map((entry) => [entry.sessionId, entry.until]))
  // Since when each excluded, returned or due session has been missing from a non-empty live list.
  const missingSince = new Map<string, number>()

  const entries = (): ExcludedEntry[] => [...excluded].map(([sessionId, exclusion]) => entryOf(sessionId, exclusion))
  const dueEntries = (): DueEntry[] => [...due].map(([sessionId, until]) => ({ sessionId, until }))
  const persist = (): void => {
    options.persist({ excluded: entries(), due: dueEntries() })
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
    reply: () => ({
      excluded: entries(),
      returned: [...returned],
      due: dueEntries(),
      ...(options.weeklyReset === undefined ? {} : { weeklyReset: { ...options.weeklyReset } }),
    }),
    quietFinishes(sessions) {
      const quiet = new Set(excluded.keys())
      for (const session of sessions) {
        const until = due.get(session.sessionId)
        if (until !== undefined && (session.stoppedAt === undefined || session.stoppedAt <= until)) quiet.add(session.sessionId)
      }
      return quiet
    },
    exclude(sessionId, sessions) {
      const session = sessions.find((s) => s.sessionId === sessionId)
      if (excluded.has(sessionId) || session === undefined) return false
      excluded.set(sessionId, { whileRunning: session.status !== 'idle', until: undefined })
      // Its absence counts from here on, not from a mark's.
      returned.delete(sessionId)
      due.delete(sessionId)
      missingSince.delete(sessionId)
      persist()
      return true
    },
    excludeUntil(sessionId, until, sessions, now) {
      if (!isFutureTime(until, now)) return false
      const current = excluded.get(sessionId)
      if (current !== undefined) {
        if (current.until === until) return false
        excluded.set(sessionId, { whileRunning: current.whileRunning, until })
      } else {
        const session = sessions.find((s) => s.sessionId === sessionId)
        if (session === undefined) return false
        excluded.set(sessionId, { whileRunning: session.status !== 'idle', until })
        returned.delete(sessionId)
        due.delete(sessionId)
      }
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
      const hadReturned = returned.delete(sessionId)
      const hadDue = due.delete(sessionId)
      if (!hadReturned && !hadDue) return false
      missingSince.delete(sessionId)
      if (hadDue) persist()
      return true
    },
    clearDue(sessionId) {
      if (!due.delete(sessionId)) return false
      missingSince.delete(sessionId)
      persist()
      return true
    },
    observe(sessions, now) {
      let stored = false
      let marksChanged = false
      // The time first, whatever the list says: an empty list is no picture, and a scan can drop a
      // live session for a moment, so neither may keep a session out past its time or lose its mark.
      for (const [id, { until }] of excluded) {
        if (until === undefined || until > now) continue
        excluded.delete(id)
        due.set(id, until)
        missingSince.delete(id)
        stored = true
        options.log(`[claudeswitcher] the exclusion time of session ${id} passed: back in the list, marked`)
      }
      if (sessions.length === 0) {
        missingSince.clear()
        if (stored) persist()
        return stored
      }
      const live = new Map(sessions.map((s) => [s.sessionId, s]))
      for (const [id, { whileRunning, until }] of excluded) {
        const session = live.get(id)
        if (session === undefined) {
          // Not gone before its time (see the module's comment); without a time, by the gone rule.
          if (until !== undefined) missingSince.delete(id)
          else if (goneFor(id, now)) {
            excluded.delete(id)
            stored = true
          }
          continue
        }
        missingSince.delete(id)
        if (!whileRunning && session.status !== 'idle') {
          // Its time, if any, goes with it: it is back for another reason.
          excluded.delete(id)
          returned.add(id)
          stored = true
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
      for (const id of due.keys()) {
        if (live.has(id)) missingSince.delete(id)
        else if (goneFor(id, now)) {
          due.delete(id)
          stored = true
        }
      }
      if (stored) persist()
      return stored || marksChanged
    },
  }
}
