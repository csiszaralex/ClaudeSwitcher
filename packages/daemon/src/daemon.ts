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
  /** A felhasználó döntése egy függő kérésről (az overlayből, IPC-n át). */
  decide(id: string, decision: UserDecision): DecideResult
  stop(): Promise<void>
}

export interface DaemonOptions {
  claudeDir: string
  probe: ProcessProbe
  /** Poll periódus ms-ben, alapból `POLL_INTERVAL_MS`. 0 kikapcsolja (tesztekhez). */
  pollMs?: number | undefined
  /**
   * A port, amire a daemon köt. 0: ideiglenes (tesztekhez). A desktop fix portot ad, mert a
   * telepített hookok egy rögzített URL-t kapnak a settings.json-ban.
   */
  port?: number | undefined
  /** A daemon tokenje. Ha nincs megadva, véletlen. A desktop tartós tokent ad, ugyanezért. */
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
        // Kör vége vagy session vége: ha a VSCode-ban tiltottak, erről csak így értesülünk (a
        // tiltásnak nincs PostToolUse-a). A Stop csak a fő agent kéréseit zárja, egy háttérben
        // futó subagent kérése a #pending-en át továbbra is várakozónak mutatja a sessiont.
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
        // Előbb a Notification-várakozás, aztán a függés: így egyik köztes állapot sem mutat
        // „waiting" sessiont függő döntés nélkül: a függés még tartja, amíg a broker le nem zárja.
        sessions.applyToolFinished(event.sessionId)
        decisions.postToolUse(event)
      },
      onSubagentStop: (event) => {
        decisions.subagentStopped(event.sessionId, event.agentId)
      },
    },
    // Diagnosztika, alapból kikapcsolva. A hookok valódi alakja nincs dokumentálva, és egy
    // rosszul olvasott mezőnév ugyanúgy néz ki, mint egy hiányzó adat, ezzel a nyers
    // törzs megnézhető anélkül, hogy a kódot kellene átírni hozzá.
    process.env['CLAUDESWITCHER_HOOK_LOG'],
  )

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: DAEMON_HOST, port: requestedPort }, () => {
      resolve(s)
    })
    // Foglalt porton a listen `error` eseményt emittál. Kezelő nélkül ez elkapatlan kivétel
    // lenne; így a startDaemon elutasít, a desktop pedig indulási hibadialógust mutat.
    s.on('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  // A @hono/node-server `serve()` egy node:http Servert ad vissza a
  // default (nem HTTP/2) konfigurációval; a WS hub ezen osztozik.
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
    // Sessionönként a legrégebbi függő döntés: amíg az tart, a session várakozó. A store
    // emittál, az pedig broadcastol: a döntések listája is ezzel megy ki.
    const pendingSince = decisions.pendingSinceBySession()
    // A kliens bontotta a kapcsolatot (natív Nem vagy Esc): a Notification-várakozást csak akkor
    // töröljük, ha a sessionnek nem maradt másik tartott kérése. Ha maradt, a prompt még nyitva
    // lehet, és a várakozást annak a lezárása viszi el.
    const abortedByClient =
      abortedSessionId !== undefined && !pendingSince.has(abortedSessionId) ? abortedSessionId : undefined
    sessions.applyPending(pendingSince, Date.now(), resolvedSessionId, abortedByClient)
  })

  let refreshing: Promise<void> | undefined
  async function refresh(): Promise<void> {
    // Egyszerre csak egy szkennelés fusson: a poll és a lifecycle hookok egymást átfedve is indíthatják.
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      try {
        const now = Date.now()
        // A függő döntésű subagentek címkéje akkor is kell, ha a subagent régóta nem írt (engedélyre
        // vár). A forrás maga a broker, így nincs külön, elavulni képes másolat.
        const heldAgents = new Set(
          decisions.views().flatMap((view) => (view.agentId === undefined ? [] : [view.agentId])),
        )
        const snapshot = await scanSessions(claudeDir, probe, now, heldAgents)
        sessions.applySnapshot(snapshot.sessions, snapshot.activities, now, snapshot.subagents)
        // Csak sikeres szkennelés után: egy elbukott szkennelés nem „eltűnt minden session".
        decisions.pruneAbsent(new Set(snapshot.sessions.map((session) => session.record.sessionId)))
        // Életjel MINDEN sikeres szkennelés után, akkor is, ha a pillanatkép nem változott.
        // Enélkül a kliens nem tudja megkülönböztetni azt, hogy „élünk, csak nincs
        // változás", attól, hogy „megállt a poll", és épp a monitorozó eszköznél a
        // legrosszabb kimenet, ha egy állott lista élőnek látszik. Egy WebSocket-ping ezt
        // NEM fedné: a socket akkor is egészséges, ha a szkennelés halt meg.
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
      // A tartott kéréseket a szerver lezárása ELŐTT kell megválaszolni: a nyitott
      // kapcsolatok miatt a server.close() különben soha nem térne vissza. A broker ezzel le is
      // zárul: egy közben vagy ezután érkező PermissionRequest azonnal üres 200-at kap.
      decisions.releaseAll()
      // Megvárjuk a futó szkennelést: leállás után ne maradjon dolgozó ígéret,
      // ami a processzt életben tartja vagy egy már lezárt hubba írna.
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
 * A `server.close()` a befejezett kérés utáni, tétlen keep-alive kapcsolatot bontja, azt viszont
 * nem, amelyen még nem jött kérés, és addig nem tér vissza, amíg a kliens azt nem bontja. Mérve
 * (2026-10-28, Node 24): a Node `fetch` egy megszakított tartott kérés után ilyen üres kapcsolatot
 * nyit, és csak ~4 mp múlva bontja. Ez hosszabb, mint amennyit a desktop kilépéskor vár
 * (`STOP_TIMEOUT_MS`).
 * Leállításkor ezért minden kapcsolatot bontunk, amelyen épp nincs nyitott kérés. A nyitott
 * kérésűt nem: azon a `releaseAll` üres 200-a még úton lehet.
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
