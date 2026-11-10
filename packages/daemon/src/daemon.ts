import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { DAEMON_HOST, DAEMON_PROTOCOL, POLL_INTERVAL_MS, type ProcessProbe, type SessionView, type UserDecision } from '@claudeswitcher/core'
import { DecisionBroker, type DecideResult, type PendingDecisionView } from './decision-broker.js'
import { createHookApp } from './hook-server.js'
import { Hub } from './hub.js'
import { scanSessions } from './scanner.js'
import { SessionStore } from './session-store.js'
import { createToken } from './token.js'

export type { PendingDecisionView } from './decision-broker.js'
export { createToken, isToken } from './token.js'

export interface DaemonState {
  sessions: SessionView[]
  decisions: PendingDecisionView[]
}

export interface Daemon {
  readonly port: number
  readonly token: string
  state(): DaemonState
  refresh(): Promise<void>
  /** The user's decision on a pending request (from the overlay, over IPC). */
  decide(id: string, decision: UserDecision): DecideResult
  stop(): Promise<void>
}

export interface DaemonOptions {
  claudeDir: string
  probe: ProcessProbe
  /** The poll period in ms, `POLL_INTERVAL_MS` by default. 0 turns it off (for tests). */
  pollMs?: number | undefined
  /**
   * The port the daemon binds to. 0: ephemeral (for tests). The desktop app passes a fixed port,
   * because the installed hooks get a fixed URL in settings.json.
   */
  port?: number | undefined
  /** The daemon's token. Random when not given. The desktop app passes a persistent token, for the same reason. */
  token?: string | undefined
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { claudeDir, probe, pollMs = POLL_INTERVAL_MS, port: requestedPort = 0 } = options
  const token = options.token ?? createToken()

  const sessions = new SessionStore()
  const decisions = new DecisionBroker()

  const app = createHookApp(
    token,
    {
      onNotification: (event) => {
        sessions.applyNotification(event)
      },
      onLifecycle: (event) => {
        sessions.applyLifecycle(event)
        // End of the turn or of the session: if the user denied in VS Code, this is the only way to
        // learn it (a denial has no PostToolUse). The Stop closes only the main agent's requests; a
        // background subagent's request keeps the session waiting through #pending.
        if (event.kind === 'stop') decisions.sessionStopped(event.sessionId)
        if (event.kind === 'end') decisions.sessionEnded(event.sessionId)
        void refresh()
      },
      onPermissionRequest: (request, signal) => decisions.hold(request, signal),
      onPreToolUse: (event) => {
        sessions.applyToolStarted(event.sessionId)
        decisions.preToolUse(event)
      },
      onPostToolUse: (event) => {
        // The Notification wait first, then the pending decision: so no intermediate state shows a
        // "waiting" session without a pending decision, which keeps it waiting until the broker closes it.
        sessions.applyToolFinished(event.sessionId)
        decisions.postToolUse(event)
      },
      onSubagentStop: (event) => {
        decisions.subagentStopped(event.sessionId, event.agentId)
      },
    },
    // Diagnostics, off by default. The real shape of the hooks is undocumented, and a misread field
    // name looks the same as missing data; with this the raw body can be inspected without changing
    // the code.
    process.env['CLAUDESWITCHER_HOOK_LOG'],
  )

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: DAEMON_HOST, port: requestedPort }, () => {
      resolve(s)
    })
    // On a port in use, listen emits an `error` event. Without a handler it would be an uncaught
    // exception; this way startDaemon rejects, and the desktop app shows a start-up error dialog.
    s.on('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  // The @hono/node-server `serve()` returns a node:http Server with the default (not HTTP/2)
  // configuration; the WS hub shares it.
  const hub = new Hub(server as HttpServer, token)
  const connections = trackOpenRequests(server as HttpServer)

  function state(): DaemonState {
    return { sessions: sessions.views(), decisions: decisions.views() }
  }

  // The SessionStore signals on every `apply*` call, also when the state did not change, so every
  // poll (`POLL_INTERVAL_MS`) would send the same snapshot again. The filter is here on purpose, not
  // in the store: the store only says "something happened", the hub decides what is worth sending.
  // Comparing the serialised form is exact, unlike a field-by-field diff, which can be got wrong.
  let lastBroadcast = ''
  function broadcast(): void {
    const message = JSON.stringify({ type: 'state', protocol: DAEMON_PROTOCOL, payload: state() })
    if (message === lastBroadcast) return
    lastBroadcast = message
    hub.broadcastRaw(message)
  }

  sessions.onChange(broadcast)

  // `resolvedSessionId` marks a change the app itself caused (a successful decide), so the store
  // can clear the pending state and the Notification wait in one step, with a single broadcast.
  decisions.onChange(({ abortedSessionId, resolvedSessionId }) => {
    // The oldest pending decision per session: while it lasts, the session is waiting. The store
    // emits and that broadcasts: the list of decisions goes out this way too.
    const pendingSince = decisions.pendingSinceBySession()
    // The client closed the connection (native No or Esc): the Notification wait is cleared only if
    // the session has no other held request left. If it has, the prompt may still be open, and its
    // close takes the wait away.
    const abortedByClient =
      abortedSessionId !== undefined && !pendingSince.has(abortedSessionId) ? abortedSessionId : undefined
    sessions.applyPending(pendingSince, Date.now(), resolvedSessionId, abortedByClient)
  })

  let refreshing: Promise<void> | undefined
  async function refresh(): Promise<void> {
    // Only one scan at a time: the poll and the lifecycle hooks can start it overlapping.
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      try {
        const now = Date.now()
        // The label of a subagent with a pending decision is needed even when the subagent has not
        // written for long (it waits for a permission). The source is the broker itself, so there is
        // no separate copy that could go stale.
        const heldAgents = new Set(
          decisions.views().flatMap((view) => (view.agentId === undefined ? [] : [view.agentId])),
        )
        const snapshot = await scanSessions(claudeDir, probe, now, heldAgents)
        sessions.applySnapshot(snapshot.sessions, snapshot.activities, now, snapshot.subagents)
        // Only after a successful scan: a failed scan is not "every session vanished".
        decisions.pruneAbsent(new Set(snapshot.sessions.map((session) => session.record.sessionId)))
        // A heartbeat after EVERY successful scan, even when the snapshot did not change. Without it
        // the client cannot tell "alive, just no change" from "the poll stopped", and for a
        // monitoring tool the worst outcome is a stale list that looks live. A WebSocket ping would
        // NOT cover this: the socket stays healthy even when the scanning died.
        hub.broadcastRaw(JSON.stringify({ type: 'tick', protocol: DAEMON_PROTOCOL, at: Date.now() }))
      } catch (error) {
        console.error('[daemon] refresh failed', error)
      } finally {
        refreshing = undefined
      }
    })()
    return refreshing
  }

  const timer = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : undefined
  timer?.unref()

  return {
    port,
    token,
    state,
    refresh,
    decide: (id, decision) => decisions.decide(id, decision),
    async stop() {
      if (timer !== undefined) clearInterval(timer)
      // The held requests must be answered BEFORE the server closes: with the open connections
      // server.close() would never return otherwise. This also closes the broker: a
      // PermissionRequest arriving meanwhile or later gets an empty 200 at once.
      decisions.releaseAll()
      // Wait for a running scan: after shutdown no working promise may remain that keeps the
      // process alive or writes into a closed hub.
      await refreshing?.catch(() => undefined)
      await hub.close()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        connections.destroyIdle()
      })
    },
  }
}

/**
 * `server.close()` closes an idle keep-alive connection after a finished request, but not one that
 * has not carried a request yet, and it does not return until the client closes that one. Measured
 * (2026-10-28, Node 24): after an aborted held request the Node `fetch` opens such an empty
 * connection and closes it only about 4 s later. That is longer than the desktop app waits on quit
 * (`STOP_TIMEOUT_MS`).
 * So on shutdown every connection without an open request is destroyed. One with an open request is
 * not: the empty 200 of `releaseAll` may still be on its way there.
 */
function trackOpenRequests(server: HttpServer): { destroyIdle(): void } {
  const openRequests = new Map<Socket, number>()
  server.on('connection', (socket: Socket) => {
    openRequests.set(socket, 0)
    socket.on('close', () => openRequests.delete(socket))
  })
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const socket = request.socket
    openRequests.set(socket, (openRequests.get(socket) ?? 0) + 1)
    response.on('close', () => {
      const open = openRequests.get(socket)
      if (open !== undefined) openRequests.set(socket, open - 1)
    })
  })
  return {
    destroyIdle() {
      for (const [socket, open] of openRequests) if (open === 0) socket.destroy()
    },
  }
}
