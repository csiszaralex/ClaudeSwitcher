import { randomUUID } from 'node:crypto'
import {
  PERMISSION_RELEASE_AFTER_MS,
  POLL_INTERVAL_MS,
  buildHookResponse,
  type HookDecisionBody,
  type PermissionRequestInfo,
  type UserDecision,
} from '@claudeswitcher/core'

/**
 * A RELEASED request is kept this long after its session dropped out of the registry snapshot: ten
 * polls (`POLL_INTERVAL_MS`), so a missed or half-written registry file does not close a live
 * session. When the session's process died, no SessionEnd comes, and without this the row would
 * stay forever. A request that can still be decided is NEVER closed by this (design doc, section 8:
 * approving works without the discovery); that one is closed by the hook client disconnecting,
 * which comes with the process's death.
 */
export const ABSENT_SESSION_GRACE_MS = 10 * POLL_INTERVAL_MS

/** How long a PreToolUse waits for its PermissionRequest to arrive. */
const PRE_TOOL_USE_TTL_MS = 60_000
/** An upper bound on the unmatched PreToolUse events, so even a busy session does not leak. */
const PRE_TOOL_USE_CAP = 500

export interface PendingDecisionView extends PermissionRequestInfo {
  id: string
  createdAt: number
  /** True once the app released it (after `PERMISSION_RELEASE_AFTER_MS`): from then on it can be decided only in VS Code or on the phone. */
  released: boolean
}

/** A tool call from the PreToolUse / PostToolUse hook. */
export interface ToolUseEvent {
  sessionId: string
  /** The subagent's `agent_id`; absent for a call of the main agent. A subagent comes with the parent's session_id. */
  agentId?: string | undefined
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
}

export type DecideResult = { ok: true } | { ok: false; reason: string }

/** The cause of a change, which the listeners get beyond a bare "something happened". */
export interface DecisionChange {
  /**
   * The session one of whose requests this change closed because the hook client closed the
   * connection (a native No or Esc in VS Code, or the death of the session's process). `undefined`
   * on every other change.
   */
  readonly abortedSessionId: string | undefined
  /**
   * Set only by a successful `decide`: the session whose request the app just resolved. The broker
   * emits exactly once, synchronously, inside `decide`, so a listener can tell this change apart
   * from every other kind. Absent on all other changes.
   */
  readonly resolvedSessionId?: string
}

const NO_ABORT: DecisionChange = { abortedSessionId: undefined }

/** Time and timers. Fakeable in tests, so the release time need not be waited out. */
export interface BrokerClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: BrokerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    // A held decision must not keep the process alive on exit.
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

interface Pending {
  view: PendingDecisionView
  key: string
  toolUseId: string | undefined
  timer: unknown
  /** Since when its session is missing from the registry snapshot; `undefined` while it is there. */
  absentSince: number | undefined
  /** Removes the client disconnect listener. Runs on close and on release. */
  detach: () => void
  respond: (body: HookDecisionBody | undefined) => void
}

/** Serialisation independent of key order, so the PreToolUse and the PermissionRequest input match. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The key that pairs a PreToolUse with its PermissionRequest. `agentId` is part of it because a
 * subagent requests with the parent's session_id: without it the same parallel call of the main
 * agent and of a subagent could take each other's id.
 */
function callKey(
  sessionId: string,
  agentId: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  return `${sessionId}\u0000${agentId ?? ''}\u0000${toolName}\u0000${stable(toolInput)}`
}

/**
 * The owner of the held PermissionRequests: the only real concurrent state machine of the system.
 *
 * A decision can come from three sources, and the first one wins: the app (`decide`), VS Code or the
 * phone (`postToolUse`, `sessionStopped`, `sessionEnded`, `subagentStopped`), or the release. The hook
 * client disconnecting and the clean-up of a vanished session's released request (`pruneAbsent`)
 * close without an answer. Every held request gets exactly one answer: the `respond` function's own
 * latch guarantees it, whichever path gets there first.
 */
export class DecisionBroker {
  readonly #clock: BrokerClock
  readonly #releaseAfterMs: number
  readonly #pending = new Map<string, Pending>()
  readonly #listeners: Array<(change: DecisionChange) => void> = []
  #recentPre: Array<{ key: string; toolUseId: string; at: number }> = []
  /** True after `releaseAll`: the daemon is shutting down and no new request is held. */
  #closed = false

  constructor(clock: BrokerClock = systemClock, releaseAfterMs: number = PERMISSION_RELEASE_AFTER_MS) {
    this.#clock = clock
    this.#releaseAfterMs = releaseAfterMs
  }

  onChange(listener: (change: DecisionChange) => void): void {
    this.#listeners.push(listener)
  }

  /**
   * Holds the request. The returned promise resolves with the hook's answer; `undefined` = no decision.
   *
   * @param signal The hook client's connection. When it closes (cancelled in VS Code, the session's
   * process died), there is nobody to answer: the request closes without an answer and leaves the list.
   */
  hold(request: PermissionRequestInfo, signal?: AbortSignal): Promise<HookDecisionBody | undefined> {
    // Nothing is held after shutdown (releaseAll): a request arriving then would otherwise hold up
    // server.close() until the release. The empty 200 is "no decision", the native prompt stays.
    if (this.#closed || signal?.aborted === true) return Promise.resolve(undefined)

    const id = randomUUID()
    const key = callKey(request.sessionId, request.agentId, request.toolName, request.toolInput)
    const toolUseId = this.#takeRecentPre(key)

    return new Promise<HookDecisionBody | undefined>((resolve) => {
      let settled = false
      const onAbort = (): void => {
        this.#finish(id, undefined, { abortedSessionId: request.sessionId })
      }
      const pending: Pending = {
        view: { ...request, id, createdAt: this.#clock.now(), released: false },
        key,
        toolUseId,
        timer: undefined,
        absentSince: undefined,
        detach: () => {
          signal?.removeEventListener('abort', onAbort)
        },
        respond: (body) => {
          if (settled) return
          settled = true
          resolve(body)
        },
      }
      pending.timer = this.#clock.setTimeout(() => {
        this.#release(id)
      }, this.#releaseAfterMs)
      this.#pending.set(id, pending)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#emit()
    })
  }

  /** The user's decision from the app. On an invalid decision the request stays pending. */
  decide(id: string, decision: UserDecision): DecideResult {
    const pending = this.#pending.get(id)
    if (pending === undefined) return { ok: false, reason: 'Ez a kérés már lezárult.' }
    if (pending.view.released) {
      return { ok: false, reason: 'Az app már elengedte ezt a kérést. Dönts a VSCode-ban.' }
    }
    const result = buildHookResponse(pending.view, decision)
    if (!result.ok) return result
    this.#finish(id, result.body, { abortedSessionId: undefined, resolvedSessionId: pending.view.sessionId })
    return { ok: true }
  }

  /** The PreToolUse brings the `tool_use_id` that the PermissionRequest lacks. */
  preToolUse(event: ToolUseEvent): void {
    const key = callKey(event.sessionId, event.agentId, event.toolName, event.toolInput)
    // If the PermissionRequest got here first for some reason, it is bound now.
    for (const pending of this.#pending.values()) {
      if (pending.key === key && pending.toolUseId === undefined) {
        pending.toolUseId = event.toolUseId
        return
      }
    }
    const now = this.#clock.now()
    this.#recentPre = this.#recentPre
      .filter((entry) => now - entry.at < PRE_TOOL_USE_TTL_MS)
      .slice(-(PRE_TOOL_USE_CAP - 1))
    this.#recentPre.push({ key, toolUseId: event.toolUseId, at: now })
  }

  /**
   * The tool has run (successfully or with an error), so the decision was already made elsewhere
   * (VS Code, phone).
   *
   * The call's Pre also leaves the list if it is still there: the Pre of a call that ran without a
   * permission would stay there for 60 s, and an identical call that does ask for permission would
   * get the old id.
   */
  postToolUse(event: { sessionId: string; toolUseId: string }): void {
    this.#recentPre = this.#recentPre.filter((entry) => entry.toolUseId !== event.toolUseId)
    this.#closeWhere((pending) => pending.toolUseId === event.toolUseId)
  }

  /**
   * The session's main turn ended (Stop): the MAIN agent's requests are no longer pending. The
   * subagents' requests still are: a `run_in_background` subagent keeps running after the Stop and
   * requests with the parent's session_id. Those are closed by the SubagentStop, the PostToolUse,
   * the client disconnecting or the SessionEnd.
   */
  sessionStopped(sessionId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId && pending.view.agentId === undefined)
  }

  /** The session ended (SessionEnd): nothing is pending for it any more, its subagents included. */
  sessionEnded(sessionId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId)
  }

  /** A subagent stopped. It runs under the parent's session_id, so the agent_id decides. */
  subagentStopped(sessionId: string, agentId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId && pending.view.agentId === agentId)
  }

  /**
   * After a fresh registry snapshot: closes the RELEASED requests whose session has been missing for
   * longer than the grace period (see ABSENT_SESSION_GRACE_MS). It tracks the start of the absence for
   * every request, so a request released just now also closes at once if its session vanished long
   * ago. Call it only after a successful scan: a failed scan is not an "empty registry".
   */
  pruneAbsent(liveSessionIds: ReadonlySet<string>): void {
    const now = this.#clock.now()
    this.#closeWhere((pending) => {
      if (liveSessionIds.has(pending.view.sessionId)) {
        pending.absentSince = undefined
        return false
      }
      pending.absentSince ??= now
      return pending.view.released && now - pending.absentSince >= ABSENT_SESSION_GRACE_MS
    })
  }

  /** Releases every held request when the daemon shuts down, BEFORE `server.close()`. */
  releaseAll(): void {
    this.#closed = true
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timer)
      pending.detach()
      pending.respond(undefined)
    }
    this.#pending.clear()
    this.#emit()
  }

  views(): PendingDecisionView[] {
    return [...this.#pending.values()].map((pending) => pending.view).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** For each session with a held request, the `createdAt` of its oldest one. */
  pendingSinceBySession(): Map<string, number> {
    const since = new Map<string, number>()
    for (const { view } of this.#pending.values()) {
      const earlier = since.get(view.sessionId)
      if (earlier === undefined || view.createdAt < earlier) since.set(view.sessionId, view.createdAt)
    }
    return since
  }

  /**
   * The oldest identical PreToolUse not paired yet. Measured order: PreToolUse, then the
   * PermissionRequest about 15 ms later, and Claude Code sends the requests in the order of the
   * calls. For two identical calls in the order Pre(id1), Pre(id2), A, B, A belongs to id1: searching
   * from the newest would swap them, and id1's PostToolUse would close B. This is also right for the
   * interleaved order Pre(id1), A, Pre(id2), B.
   */
  #takeRecentPre(key: string): string | undefined {
    const now = this.#clock.now()
    const index = this.#recentPre.findIndex((entry) => entry.key === key && now - entry.at < PRE_TOOL_USE_TTL_MS)
    if (index === -1) return undefined
    const [entry] = this.#recentPre.splice(index, 1)
    return entry?.toolUseId
  }

  #release(id: string): void {
    const pending = this.#pending.get(id)
    if (pending === undefined || pending.view.released) return
    // The answer has gone out and the connection closes normally: watching for a disconnect is no longer needed.
    pending.detach()
    pending.respond(undefined)
    // The row stays, as the native prompt does. It is closed by the PostToolUse, the Stop / SessionEnd /
    // SubagentStop, or (if the session vanished from the registry) by pruneAbsent.
    pending.view = { ...pending.view, released: true }
    this.#emit()
  }

  #finish(id: string, body: HookDecisionBody | undefined, change: DecisionChange = NO_ABORT): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#clock.clearTimeout(pending.timer)
    pending.detach()
    pending.respond(body)
    this.#pending.delete(id)
    this.#emit(change)
  }

  #closeWhere(predicate: (pending: Pending) => boolean): void {
    for (const [id, pending] of [...this.#pending]) {
      if (predicate(pending)) this.#finish(id, undefined)
    }
  }

  #emit(change: DecisionChange = NO_ABORT): void {
    for (const listener of this.#listeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('[decisions] listener failed', error)
      }
    }
  }
}
