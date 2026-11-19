import type { PromptSender, SessionStatus } from '@claudeswitcher/core'

/** The part of a session the links read; the daemon's `SessionView` fits it. */
export interface LinkedSession {
  sessionId: string
  name?: string | undefined
  status: SessionStatus
  /** The session's pipe (`SessionView.messagingSocketPath`): how a recipient names this session as its sender. */
  messagingSocketPath?: string | undefined
  /** The senders this session works for (`SessionActivity.promptedBy`, core `cross-session.ts`). */
  activity?: { promptedBy?: readonly PromptSender[] | undefined } | undefined
}

/** A stable order of sessions by their row name, then by session id. */
function byName(a: LinkedSession, b: LinkedSession): number {
  return (a.name ?? '').localeCompare(b.name ?? '') || a.sessionId.localeCompare(b.sessionId)
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
 * The names of the sessions `session` works for now, for the note on its row: each sender's row
 * name when a live session has its pipe, else the name its message gave; a sender with neither is
 * left out. Empty while the session is idle, the same condition `recipientsOf` puts on the
 * recipient. Each name once, in a stable order.
 */
export function promptersOf(session: LinkedSession, sessions: readonly LinkedSession[]): string[] {
  if (session.status === 'idle') return []
  const names = (session.activity?.promptedBy ?? []).flatMap((sender) => {
    const live = sessions.find((other) => other.sessionId !== session.sessionId && other.messagingSocketPath === sender.pipe)
    const name = live?.name !== undefined && live.name !== '' ? live.name : sender.name
    return name === undefined || name === '' ? [] : [name]
  })
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}
