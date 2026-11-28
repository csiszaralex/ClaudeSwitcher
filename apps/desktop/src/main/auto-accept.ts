import { POLL_INTERVAL_MS, type UserDecision } from '@claudeswitcher/core'
import type { AutoDecider } from '@claudeswitcher/daemon'
import { ALLOW_DECISION, autoAcceptTakes, type AutoAcceptEntry, type AutoAcceptRequest } from '../shared/auto-accept.js'
import type { DecideOutcome } from '../shared/overlay-channels.js'

/**
 * How long a session in the mode must be missing from the daemon's state, without a break, before
 * it leaves the mode (`createAutoAccept` `observe`). Ten polls (`POLL_INTERVAL_MS`), as the daemon's
 * `ABSENT_SESSION_GRACE_MS`: a scan drops a session whose registry file it cannot read at that
 * moment (daemon `scanner.ts`), and one such scan must not end the mode. A bound, not a measurement.
 */
export const AUTO_ACCEPT_GONE_AFTER_MS = 10 * POLL_INTERVAL_MS

/** The part of a pending request the controller reads; the daemon's `PendingDecisionView` fits it. */
interface ModeRequest extends AutoAcceptRequest {
  id: string
  sessionId: string
  toolName: string
}

/** The part of a listed session the controller reads; the daemon's `SessionView` fits it. */
interface ModeSession {
  sessionId: string
  /** When the user last sent the session a prompt of his own (core `SessionActivity.lastOwnPromptAt`). */
  activity?: { lastOwnPromptAt?: number | undefined } | undefined
}

/** The part of the daemon's state the controller reads; `DaemonState` fits it. */
export interface ModeState {
  sessions: readonly ModeSession[]
  decisions: readonly ModeRequest[]
}

/** The part of the daemon the controller uses at switch-on; the running `Daemon` fits it. */
export interface ModeDaemon {
  state(): ModeState
  decide(id: string, decision: UserDecision): DecideOutcome
}

export interface AutoAcceptOptions {
  /** Writes one line to the main log; `console.log` in the app. */
  log: (line: string) => void
  /** Called after every change of the sessions in the mode or of their counts (the overlay's push). */
  onChange: () => void
}

export interface AutoAccept {
  /** For `startDaemon`: decides every new request of a session in the mode that the mode takes. */
  readonly decider: AutoDecider
  /**
   * Turns the mode on or off for a session. On needs a session the daemon knows now (listed, or with
   * a pending request), and allows at once every request of it that waits and that the mode takes
   * (`autoAcceptTakes`), oldest first; the count starts at what it allowed. Both directions are
   * idempotent. True when the set changed. The session's last own prompt at that moment is the
   * count's start: only a later one resets it (`observe`).
   */
  set(sessionId: string, on: boolean, daemon: ModeDaemon): boolean
  /**
   * From the daemon's state at `now`: sets the count of a session in the mode back to 0 when the
   * session shows an own prompt later than the one the count started at (the user spoke to it), and
   * drops the sessions that have been gone for `AUTO_ACCEPT_GONE_AFTER_MS` (neither listed nor with a
   * pending request). Called with every tray tick, so it works while the overlay is closed. Calls
   * `onChange` for a count that changed; true when the set changed.
   */
  observe(state: ModeState, now: number): boolean
  /** The sessions in the mode and their counts, in the order they were turned on: the IPC reply. */
  entries(): AutoAcceptEntry[]
}

/**
 * The per-session auto-accept mode in the main process, beside the daemon, so it works while the
 * overlay is closed. In memory only: empty after a restart. A new request reaches it through the
 * daemon's `AutoDecider`, inside the broker's `hold`: a request it allows is closed before any
 * listener hears of it, so neither the broadcast nor the tray tick's read of the state, and with it
 * the toasts (`main/notifier.ts`) and the tray (`main/tray-state.ts`), ever see it. A request it
 * does not take is held as without the mode.
 *
 * When a session counts as gone: as for the excluded sessions (`main/excluded-sessions.ts`), an
 * empty session list is no picture (before the first scan, a scan without a process snapshot), so
 * it restarts every absence (`missingSince`) and drops nothing; a session with a pending request is
 * never gone.
 */
export function createAutoAccept(options: AutoAcceptOptions): AutoAccept {
  /**
   * The sessions in the mode and how many requests it allowed for each since the user's last own
   * prompt to it (or since it was turned on, when that is later).
   */
  const allowed = new Map<string, number>()
  /**
   * The own prompt each count started at (`SessionActivity.lastOwnPromptAt`, epoch ms), so a later
   * one resets the count; absent while the session showed none. A transcript time compared with a
   * transcript time, never with the clock.
   */
  const countFrom = new Map<string, number>()
  /** Since when each session in the mode has been missing from a non-empty state. */
  const missingSince = new Map<string, number>()

  /** Counts and logs one request the mode allowed. Never the command or the file's content. */
  function record(request: ModeRequest): void {
    const count = (allowed.get(request.sessionId) ?? 0) + 1
    allowed.set(request.sessionId, count)
    options.log(
      `[claudeswitcher] auto-accept: allowed ${request.toolName} of session ${request.sessionId} (${String(count)} since the last own prompt)`,
    )
  }

  const decider: AutoDecider = {
    decisionFor: (request) => (allowed.has(request.sessionId) && autoAcceptTakes(request) ? ALLOW_DECISION : undefined),
    decided: (request, result) => {
      // A refusal leaves the request held as usual (`AutoDecider.decided`): it shows and notifies.
      if (!result.ok) {
        options.log(
          `[claudeswitcher] auto-accept: the allow of ${request.toolName} of session ${request.sessionId} was refused: ${result.reason}`,
        )
        return
      }
      record(request)
      options.onChange()
    },
  }

  return {
    decider,
    set(sessionId, on, daemon) {
      if (!on) {
        missingSince.delete(sessionId)
        countFrom.delete(sessionId)
        if (!allowed.delete(sessionId)) return false
        options.log(`[claudeswitcher] auto-accept: off for session ${sessionId}`)
        options.onChange()
        return true
      }
      if (allowed.has(sessionId)) return false
      const state = daemon.state()
      const known =
        state.sessions.some((s) => s.sessionId === sessionId) || state.decisions.some((d) => d.sessionId === sessionId)
      if (!known) return false
      allowed.set(sessionId, 0)
      const promptAt = state.sessions.find((s) => s.sessionId === sessionId)?.activity?.lastOwnPromptAt
      if (promptAt !== undefined) countFrom.set(sessionId, promptAt)
      options.log(`[claudeswitcher] auto-accept: on for session ${sessionId}`)
      // The requests that wait already (the owner's choice: the one waiting is allowed too). The
      // daemon's `decide` checks each again, so one decided meanwhile is only refused.
      for (const request of state.decisions) {
        if (request.sessionId !== sessionId || !autoAcceptTakes(request)) continue
        const result = daemon.decide(request.id, ALLOW_DECISION)
        if (result.ok) record(request)
      }
      options.onChange()
      return true
    },
    observe(state, now) {
      let counted = false
      for (const session of state.sessions) {
        const promptAt = session.activity?.lastOwnPromptAt
        const count = allowed.get(session.sessionId)
        if (count === undefined || promptAt === undefined) continue
        const from = countFrom.get(session.sessionId)
        if (from !== undefined && promptAt <= from) continue
        countFrom.set(session.sessionId, promptAt)
        if (count === 0) continue
        allowed.set(session.sessionId, 0)
        options.log(`[claudeswitcher] auto-accept: a new own prompt of session ${session.sessionId}; the count starts again`)
        counted = true
      }
      if (counted) options.onChange()
      if (state.sessions.length === 0) {
        missingSince.clear()
        return false
      }
      const live = new Set([...state.sessions, ...state.decisions].map((item) => item.sessionId))
      let dropped = false
      for (const sessionId of allowed.keys()) {
        if (live.has(sessionId)) {
          missingSince.delete(sessionId)
          continue
        }
        const since = missingSince.get(sessionId)
        if (since === undefined) {
          missingSince.set(sessionId, now)
        } else if (now - since >= AUTO_ACCEPT_GONE_AFTER_MS) {
          allowed.delete(sessionId)
          missingSince.delete(sessionId)
          countFrom.delete(sessionId)
          options.log(`[claudeswitcher] auto-accept: session ${sessionId} is gone; off`)
          dropped = true
        }
      }
      if (dropped) options.onChange()
      return dropped
    },
    entries: () => [...allowed].map(([sessionId, count]) => ({ sessionId, allowed: count })),
  }
}
