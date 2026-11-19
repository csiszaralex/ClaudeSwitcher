import type { PromptSender, SessionStatus } from '@claudeswitcher/core'
import { sessionName, type NamedSession } from './session-name.js'

/** The part of a session the links read; the daemon's `SessionView` fits it. */
export interface LinkedSession extends NamedSession {
  sessionId: string
  name?: string | undefined
  status: SessionStatus
  /** The session's pipe (`SessionView.messagingSocketPath`): how a recipient names this session as its sender. */
  messagingSocketPath?: string | undefined
  /** The senders this session works for (`SessionActivity.promptedBy`, core `cross-session.ts`). */
  activity?: { promptedBy?: readonly PromptSender[] | undefined; tabTitle?: unknown } | undefined
}

/** A stable order of sessions by their shown name (`sessionName`), then by session id. */
function byName(a: LinkedSession, b: LinkedSession): number {
  return sessionName(a).localeCompare(sessionName(b)) || a.sessionId.localeCompare(b.sessionId)
}

/**
 * The other live sessions that work for `session` now: those whose `activity.promptedBy` names its
 * pipe and that work or wait (`status` not `idle`). A recipient that went idle or is gone from the
 * list no longer counts, whatever its transcript still says. In a stable order: by name, then by
 * session id. A session without a pipe has no recipients.
 *
 * Only one step: a recipient that itself finished and waits on others is idle, so it does not count.
 * It could not count anyway: its own turn that handled the message has ended, so its `promptedBy`
 * no longer names the sender (core `createPromptTracker`). This also keeps the rule free of loops
 * in a mesh, where sessions prompt each other.
 */
export function recipientsOf<S extends LinkedSession>(
  session: { sessionId: string; messagingSocketPath?: string | undefined },
  sessions: readonly S[],
): S[] {
  const pipe = session.messagingSocketPath
  if (pipe === undefined || pipe === '') return []
  return sessions
    .filter(
      (other) =>
        other.sessionId !== session.sessionId &&
        other.status !== 'idle' &&
        (other.activity?.promptedBy ?? []).some((sender) => sender.pipe === pipe),
    )
    .sort(byName)
}

/**
 * The names of the sessions `session` works for now, for the note on its row: each sender's shown
 * name (`sessionName`) when a live session has its pipe, else the name its message gave; a sender with neither is
 * left out. Empty while the session is idle, the same condition `recipientsOf` puts on the
 * recipient. Each name once, in a stable order.
 */
export function promptersOf(session: LinkedSession, sessions: readonly LinkedSession[]): string[] {
  if (session.status === 'idle') return []
  const names = (session.activity?.promptedBy ?? []).flatMap((sender) => {
    const name = senderName(sender, session.sessionId, sessions)
    return name === undefined ? [] : [name]
  })
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

/**
 * The name of a cross-session message's sender, as `recipientId`'s views show it (the row's note,
 * `promptersOf`, and the peek's incoming messages): the shown name (`sessionName`) of the other live
 * session that has its pipe, else the name its message gave; `undefined` with neither.
 */
export function senderName(
  sender: PromptSender,
  recipientId: string,
  sessions: readonly LinkedSession[],
): string | undefined {
  const live = sessions.find((other) => other.sessionId !== recipientId && other.messagingSocketPath === sender.pipe)
  const liveName = live === undefined ? '' : sessionName(live)
  const name = liveName !== '' ? liveName : sender.name
  return name === undefined || name === '' ? undefined : name
}
