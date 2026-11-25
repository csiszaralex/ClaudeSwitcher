import type { SessionStatus } from '@claudeswitcher/core'
import type { LinkedSession } from '../shared/prompt-links.js'
import { requestSource } from '../shared/request-source.js'
import { clip, pendingRowText } from '../shared/row-text.js'
import { waitsOn } from '../shared/session-finished.js'
import { sessionName } from '../shared/session-name.js'

/** The part of a session the notifier reads; the daemon's `SessionView` fits it. */
export interface NotifierSession extends LinkedSession {
  sessionId: string
  name: string
  status: SessionStatus
  /** The registry `entrypoint`, for the source label of a request (`requestSource`). */
  entrypoint?: string | undefined
  /** The time of the session's last `Stop`, while it has shown no new activity (`SessionView.stoppedAt`). */
  stoppedAt?: number | undefined
  activity?: (LinkedSession['activity'] & { lastAssistantText?: string | undefined; tabTitle?: string | undefined }) | undefined
}

/** The part of a pending request the notifier reads; the daemon's `PendingDecisionView` fits it. */
export interface NotifierDecision {
  id: string
  sessionId: string
  toolName: string
  summary: string
  /** Released by the app (`PERMISSION_RELEASE_AFTER_MS`): it can no longer be decided here, so it is no news. */
  released: boolean
}

export interface NotifierState {
  sessions: readonly NotifierSession[]
  decisions: readonly NotifierDecision[]
}

export interface NotifierInput {
  state: NotifierState
  settings: { notifyOnRequest: boolean; notifyOnFinish: boolean }
  /** The overlay is on screen: the user is looking at the list already, so nothing is shown. */
  overlayVisible: boolean
  /**
   * The sessions the user moved out of the list, and those back from a timed exclusion whose last
   * finish is from before their time (`main/excluded-sessions.ts` `quietFinishes`): their finishes
   * notify nothing. Their requests notify as any session's.
   */
  excluded: ReadonlySet<string>
}

/** One toast to show. A click opens the list with `sessionId` selected. */
export interface Notice {
  kind: 'request' | 'finished'
  sessionId: string
  title: string
  body: string
}

/** The title name of a request whose session is not in the list (it ended in the same moment). */
const UNKNOWN_SESSION_NAME = 'Egy session'

/**
 * The toast of a new permission request: the session's shown name (`sessionName`) in the title, the
 * row's text, with the source label first when it stands out.
 */
function requestNotice(decision: NotifierDecision, session: NotifierSession | undefined): Notice {
  const source = requestSource(session?.entrypoint)
  const text = pendingRowText(decision)
  return {
    kind: 'request',
    sessionId: decision.sessionId,
    title: `${session === undefined ? UNKNOWN_SESSION_NAME : sessionName(session)} engedélyt kér`,
    body: source.standsOut ? `${source.label} · ${text}` : text,
  }
}

/** The toast of a session that finished its turn: its shown name (`sessionName`), the start of its last answer. */
function finishedNotice(session: NotifierSession): Notice {
  return {
    kind: 'finished',
    sessionId: session.sessionId,
    title: `${sessionName(session)} végzett`,
    body: clip(session.activity?.lastAssistantText ?? ''),
  }
}

/**
 * Decides which toasts a state change deserves. Call `observe` with every tick (the one-second
 * tray tick); it remembers what it has seen.
 *
 * - The first call only learns the state: a request pending at start-up (after a restart or an
 *   update) and a stop that already happened notify nothing, the tray count shows them.
 * - A request notifies once, by its decision `id`, so a second request of the same session notifies
 *   again. A released request is no news.
 * - A session notifies once per new `stoppedAt`, and only once it waits on no session it prompted
 *   (`waitsOn`): while it waits, its `stoppedAt` is neither shown nor remembered, so the toast comes
 *   when the last recipient goes idle, with the same `stoppedAt`. A finish already notified before
 *   the wait began does not notify again. `stoppedAt` disappears while a subagent runs and
 *   comes back with the same value, which is not a new finish, so the last value is kept, also for a
 *   session that drops out of the list for a moment (one number per session id, never pruned).
 * - An excluded session's finish notifies nothing (`NotifierInput.excluded`); its requests do.
 * - The memory is updated on every call, also when a toast is held back (a setting off, the overlay
 *   visible, the session excluded): a request or a finish that arrived then never notifies later, and
 *   turning a setting on or bringing a session back does not replay the past.
 */
export function createNotifier(): { observe: (input: NotifierInput) => Notice[] } {
  let started = false
  let knownDecisions: ReadonlySet<string> = new Set()
  const lastStoppedAt = new Map<string, number>()

  return {
    observe({ state, settings, overlayVisible, excluded }) {
      const bySession = new Map(state.sessions.map((session) => [session.sessionId, session]))

      const requests: Notice[] = []
      for (const decision of state.decisions) {
        if (started && !knownDecisions.has(decision.id) && !decision.released) {
          requests.push(requestNotice(decision, bySession.get(decision.sessionId)))
        }
      }
      knownDecisions = new Set(state.decisions.map((decision) => decision.id))

      const finished: Notice[] = []
      for (const session of state.sessions) {
        const { stoppedAt } = session
        if (stoppedAt === undefined || waitsOn(session, state.sessions).length > 0) continue
        const fresh = started && lastStoppedAt.get(session.sessionId) !== stoppedAt
        if (fresh && !excluded.has(session.sessionId)) finished.push(finishedNotice(session))
        lastStoppedAt.set(session.sessionId, stoppedAt)
      }

      started = true
      if (overlayVisible) return []
      return [...(settings.notifyOnRequest ? requests : []), ...(settings.notifyOnFinish ? finished : [])]
    },
  }
}
