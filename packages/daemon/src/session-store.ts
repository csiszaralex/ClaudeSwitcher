import {
  lastPathSegment,
  type LiveSession,
  type SessionActivity,
  type SessionView,
  type SubagentView,
} from '@claudeswitcher/core'
import type { LifecycleEvent, NotificationEvent } from './hook-server.js'

/**
 * How long a wait is kept whose session is not in the snapshot yet. Well over one poll
 * (`POLL_INTERVAL_MS`), but not forever, so a session that never shows up does not leak.
 */
const UNMATCHED_WAIT_GRACE_MS = 10_000

/**
 * For this long after the app's decision a `permission_prompt` Notification is not taken as a wait.
 * Claude Code sends it about 6 s AFTER the PermissionRequest (measured live), even when the app has
 * decided by then. Without this window a quickly decided session would turn "waiting" again when
 * the Notification arrives, and stay so until the Stop. 10 s leaves headroom over the measured 6 s,
 * and a really new prompt is not lost: its own PermissionRequest shows the session as waiting
 * through the pending decision anyway.
 */
const LATE_PROMPT_WINDOW_MS = 10_000

const WAITING_TYPES = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])

interface WaitState {
  since: number
  text?: string | undefined
}

function displayName(record: LiveSession['record']): string {
  if (record.name !== undefined && record.name !== '') return record.name
  return lastPathSegment(record.cwd) ?? record.sessionId
}

/**
 * The single source of the state sent to the UI. It merges four inputs: the periodic snapshot
 * (registry + transcript), the hook events, the lifecycle events and the pending decisions. On a
 * conflict the hook wins: the snapshot comes from the transcript and can lag behind, while the hook
 * arrives the moment something happens.
 *
 * A session is waiting when it has a Notification wait, a pending decision, OR the registry shows
 * `status: 'waiting'`. When all of them are gone, the time is recorded: the non-waiting sessions
 * are sorted by it.
 *
 * The registry source is for an app restart: a PermissionRequest that went to the old daemon and
 * the one-off Notification are not repeated, only the registry knows about the wait. Display only:
 * it never creates, answers or closes a decision. On a conflict the hook wins, see `#clearedAt`.
 */
export class SessionStore {
  #sessions = new Map<string, LiveSession>()
  #activities = new Map<string, SessionActivity>()
  /** The active subagents per session from the latest snapshot. Display only. */
  #subagents: ReadonlyMap<string, readonly SubagentView[]> = new Map()
  readonly #waiting = new Map<string, WaitState>()
  /** Per session, the start of the oldest pending (or released but still open) decision. */
  #pending: ReadonlyMap<string, number> = new Map()
  /** When the session's wait last ended. For sorting only. */
  readonly #waitEndedAt = new Map<string, number>()
  /** When the app last decided one of the session's requests, for the late Notification. */
  readonly #resolvedAt = new Map<string, number>()
  /** The time of the last Stop, until the session moves again, for the "just finished" mark. */
  readonly #stoppedAt = new Map<string, number>()
  /**
   * When a hook (PostToolUse, Stop, SessionEnd, a non-waiting Notification) or the app's decision
   * last ended the session's wait. A registry `waiting` that is NOT newer than this is stale.
   *
   * Why not the 10 s window of `#resolvedAt`: the registry's lag is not a measured, fixed delay (as
   * the Notification's is) but the poll rate plus Claude Code's write. A window would either swallow
   * a really new wait or, once expired, bring back the old one if the registry has not written a new
   * one by then. `statusUpdatedAt` tells exactly whether the wait started before or after the end:
   * same machine, same clock, and the hook always reaches us AFTER the event, so the old wait's
   * stamp is always smaller.
   */
  readonly #clearedAt = new Map<string, number>()
  readonly #listeners: Array<() => void> = []

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

  #isWaiting(sessionId: string): boolean {
    return (
      this.#waiting.has(sessionId) || this.#pending.has(sessionId) || this.#registryWaitSince(sessionId) !== undefined
    )
  }

  /**
   * The start of the wait according to the registry, if the session is waiting now. Without
   * `statusUpdatedAt` it cannot be compared with the hooks, so it is ignored, as before the registry
   * carried a status (design doc, section 3.1).
   */
  #registryWaitSince(sessionId: string): number | undefined {
    const record = this.#sessions.get(sessionId)?.record
    if (record?.status !== 'waiting' || record.statusUpdatedAt === undefined) return undefined
    const cleared = this.#clearedAt.get(sessionId)
    if (cleared !== undefined && record.statusUpdatedAt <= cleared) return undefined
    return record.statusUpdatedAt
  }

  /**
   * Whether the session is working according to the registry, even when no tool is running
   * (thinking, writing text). A `busy` from before the Stop is a leftover of a lagging snapshot:
   * the session has just finished.
   */
  #registryBusy(sessionId: string): boolean {
    const record = this.#sessions.get(sessionId)?.record
    if (record?.status !== 'busy' || record.statusUpdatedAt === undefined) return false
    const stopped = this.#stoppedAt.get(sessionId)
    return stopped === undefined || record.statusUpdatedAt > stopped
  }

  /** A hook ended the wait: the Notification wait goes, and the registry's old `waiting` becomes stale. */
  #clearWait(sessionId: string, now: number): void {
    this.#waiting.delete(sessionId)
    this.#clearedAt.set(sessionId, now)
  }

  /**
   * Runs the change and records the end of the wait for the sessions that were waiting before it
   * and are not after it. In one place, so no path (decision, PostToolUse, Stop, non-waiting
   * Notification) forgets it.
   */
  #tracking(sessionIds: Iterable<string>, now: number, change: () => void): void {
    const before = [...sessionIds].filter((id) => this.#isWaiting(id))
    change()
    for (const id of before) {
      if (!this.#isWaiting(id)) this.#waitEndedAt.set(id, now)
    }
  }

  /**
   * @param subagents The active subagents per session, the most recently written first (from the
   * scanner). A missing entry means the session has no active subagent.
   */
  applySnapshot(
    sessions: LiveSession[],
    activities: Map<string, SessionActivity>,
    now: number = Date.now(),
    subagents: ReadonlyMap<string, readonly SubagentView[]> = new Map(),
  ): void {
    const ids = new Set(sessions.map((s) => s.record.sessionId))
    // The registry's `waiting` comes and goes with the snapshot, so a wait can end here too.
    this.#tracking(new Set([...this.#sessions.keys(), ...ids]), now, () => {
      this.#sessions = new Map(sessions.map((s) => [s.record.sessionId, s]))
    })
    this.#activities = activities
    this.#subagents = subagents

    // A running tool in the snapshot: the session works again after the Stop.
    for (const [id, activity] of activities) {
      if (activity.runningTool !== undefined) this.#stoppedAt.delete(id)
    }
    // Likewise a subagent's running tool: a background subagent keeps working after the main turn's Stop.
    for (const [id, list] of subagents) {
      if (list.some((subagent) => subagent.runningTool !== undefined)) this.#stoppedAt.delete(id)
    }
    // Likewise a registry `busy` or `waiting` that started AFTER the Stop: a new turn has begun. One
    // from before the Stop is a leftover of a lagging snapshot and does not clear "just finished".
    for (const { record } of sessions) {
      const stopped = this.#stoppedAt.get(record.sessionId)
      const changedAt = record.statusUpdatedAt
      if (stopped === undefined || changedAt === undefined || changedAt <= stopped) continue
      if (record.status === 'busy' || record.status === 'waiting') this.#stoppedAt.delete(record.sessionId)
    }

    for (const [id, wait] of [...this.#waiting]) {
      if (ids.has(id)) continue
      // A FRESH wait is not dropped just because the session is not in the registry yet: the hook
      // arrives at once, while the registry is read only every few seconds. After the grace period
      // it is cleaned up, though, or the wait of a session that never shows up would stay in memory
      // forever.
      if (now - wait.since < UNMATCHED_WAIT_GRACE_MS) continue
      this.#waiting.delete(id)
    }
    // The same clean-up for the timestamps, so a vanished session does not leak.
    for (const stamps of [this.#waitEndedAt, this.#stoppedAt, this.#clearedAt]) {
      for (const [id, at] of [...stamps]) {
        if (!ids.has(id) && now - at >= UNMATCHED_WAIT_GRACE_MS) stamps.delete(id)
      }
    }
    for (const [id, at] of [...this.#resolvedAt]) {
      if (now - at >= LATE_PROMPT_WINDOW_MS) this.#resolvedAt.delete(id)
    }
    this.#emit()
  }

  /**
   * Stores the wait even when the session is still unknown.
   *
   * `views()` iterates over the sessions, so an entry without a match is invisible, but as soon as
   * the next snapshot picks up the session, it shows as `waiting` at once. Such a notification used
   * to be lost FOR GOOD, and the user saw a session that was waiting for them as idle.
   */
  applyNotification(event: NotificationEvent, now: number = Date.now()): void {
    const resolvedAt = this.#resolvedAt.get(event.sessionId)
    const late =
      event.type === 'permission_prompt' && resolvedAt !== undefined && now - resolvedAt < LATE_PROMPT_WINDOW_MS
    this.#tracking([event.sessionId], now, () => {
      // The late prompt of a request already decided, see LATE_PROMPT_WINDOW_MS.
      if (late) return
      if (WAITING_TYPES.has(event.type)) {
        this.#waiting.set(event.sessionId, { since: now, text: event.text })
        this.#stoppedAt.delete(event.sessionId)
      } else {
        this.#clearWait(event.sessionId, now)
      }
    })
    this.#emit()
  }

  applyLifecycle(event: LifecycleEvent, now: number = Date.now()): void {
    this.#tracking([event.sessionId], now, () => {
      if (event.kind === 'end') {
        this.#sessions.delete(event.sessionId)
      }
      this.#clearWait(event.sessionId, now)
    })
    if (event.kind === 'stop') this.#stoppedAt.set(event.sessionId, now)
    // An ended session is not "just finished": if the registry still shows it for one more round, it must not come back so.
    if (event.kind === 'end') this.#stoppedAt.delete(event.sessionId)
    this.#emit()
  }

  /**
   * The session started a tool call (PreToolUse). The "just finished" mark after the Stop is stale
   * from now: the session works again. The snapshot would see this only later, from the transcript.
   */
  applyToolStarted(sessionId: string): void {
    this.#stoppedAt.delete(sessionId)
    this.#emit()
  }

  /**
   * A tool of the session has run (PostToolUse). So the prompt was answered (in the app, in VS Code
   * or on the phone), and the Notification wait is stale. ANOTHER decision, still pending or
   * released, keeps the session waiting through `#pending`.
   */
  applyToolFinished(sessionId: string, now: number = Date.now()): void {
    this.#tracking([sessionId], now, () => {
      this.#clearWait(sessionId, now)
    })
    this.#emit()
  }

  /**
   * The current state of the pending decisions from the broker, on every change.
   *
   * @param pendingSince Per session, the start of the oldest pending decision. Such a session is
   * waiting even when the Notification has not come yet: it arrives only after about 6 s of waiting
   * (measured), while the PermissionRequest arrives at once. A released decision
   * (`PERMISSION_RELEASE_AFTER_MS`) is included too: the native prompt is still open then.
   * @param resolvedByApp The session whose decision this change closed in the app. Its Notification
   * wait is cleared in ONE step with the pending decision: between two separate updates the renderer
   * would briefly see a session already decided but still "waiting".
   * @param abortedByClient The session whose last held request was closed by the hook client
   * disconnecting. After a native No or Esc Claude Code sends no hook at all, it only closes the
   * connection (measured, 2026-10-25), so only this can clear the Notification wait. In the same step
   * as for the app's decision, but the late prompt window (`#resolvedAt`) does NOT open: it is for
   * the race with the app's decision, and after a native answer a new prompt is a real wait.
   */
  applyPending(
    pendingSince: ReadonlyMap<string, number>,
    now: number = Date.now(),
    resolvedByApp?: string,
    abortedByClient?: string,
  ): void {
    const affected = new Set(this.#pending.keys())
    if (resolvedByApp !== undefined) affected.add(resolvedByApp)
    if (abortedByClient !== undefined) affected.add(abortedByClient)
    // A newly pending decision is a new PermissionRequest: the session moved again after the Stop.
    for (const id of pendingSince.keys()) {
      if (!this.#pending.has(id)) this.#stoppedAt.delete(id)
    }
    this.#tracking(affected, now, () => {
      this.#pending = new Map(pendingSince)
      if (resolvedByApp !== undefined) {
        this.#clearWait(resolvedByApp, now)
        this.#resolvedAt.set(resolvedByApp, now)
      }
      if (abortedByClient !== undefined) this.#clearWait(abortedByClient, now)
    })
    this.#emit()
  }

  views(): SessionView[] {
    const views: SessionView[] = []

    for (const [sessionId, session] of this.#sessions) {
      const activity = this.#activities.get(sessionId) ?? {}
      const wait = this.#waiting.get(sessionId)
      const pending = this.#pending.get(sessionId)
      const registryWait = this.#registryWaitSince(sessionId)
      const subagents = this.#subagents.get(sessionId) ?? []
      const subagentWorking = subagents.some((subagent) => subagent.runningTool !== undefined)

      // A wait (hook, decision, registry) wins over a subagent's work too.
      const status =
        wait !== undefined || pending !== undefined || registryWait !== undefined ? 'waiting'
        : activity.runningTool !== undefined || subagentWorking || this.#registryBusy(sessionId) ? 'working'
        : 'idle'

      views.push({
        sessionId,
        name: displayName(session.record),
        cwd: session.record.cwd,
        status,
        activity,
        windowPid: session.window?.pid,
        workspaceFolder: session.window?.workspaceFolders[0],
        bridgeSessionId: session.record.bridgeSessionId,
        entrypoint: session.record.entrypoint,
        // The hook sources are more precise; the registry only when none of them knows of the wait.
        waitingSince: wait?.since ?? pending ?? registryWait,
        notificationText: wait?.text,
        // No "just finished" beside an active subagent: the background work goes on after the main
        // turn's Stop. Only masked, not cleared: a subagent thinking between two tools is no new
        // activity, and when it disappears the old Stop shows again.
        stoppedAt: subagents.length > 0 ? undefined : this.#stoppedAt.get(sessionId),
        ...(subagents.length > 0 ? { subagents: [...subagents] } : {}),
      })
    }

    // Waiting sessions first, the longest waiting on top. Then the non-waiting ones: the one whose
    // wait ended most recently first (a user request: a just-decided session should not drop into
    // the middle by name); last the ones that never waited during the daemon's life, by name.
    return views.sort((a, b) => {
      if (a.status === 'waiting' && b.status !== 'waiting') return -1
      if (b.status === 'waiting' && a.status !== 'waiting') return 1
      if (a.status === 'waiting' && b.status === 'waiting') {
        return (a.waitingSince ?? 0) - (b.waitingSince ?? 0)
      }
      const endedA = this.#waitEndedAt.get(a.sessionId)
      const endedB = this.#waitEndedAt.get(b.sessionId)
      if (endedA !== undefined && endedB === undefined) return -1
      if (endedB !== undefined && endedA === undefined) return 1
      if (endedA !== undefined && endedB !== undefined && endedA !== endedB) return endedB - endedA
      return a.name.localeCompare(b.name)
    })
  }
}
