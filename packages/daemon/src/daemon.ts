import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import type { ProcessProbe, RateLimits, SessionView, UserDecision } from '@claudeswitcher/core'
import { DecisionBroker, type DecideResult, type PendingDecisionView } from './decision-broker.js'
import { createHookApp } from './hook-server.js'
import { Hub } from './hub.js'
import { RateLimitStore } from './rate-limits.js'
import { scanSessions } from './scanner.js'
import { SessionStore } from './session-store.js'

export type { DecideResult, PendingDecisionView } from './decision-broker.js'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
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
  /** Poll periódus ms-ben. 0 kikapcsolja (tesztekhez). */
  pollMs?: number | undefined
  /**
   * A port, amire a daemon köt. 0: ideiglenes (tesztekhez). A desktop fix portot ad, mert a
   * telepített hookok és a statusLine egy rögzített URL-t kapnak a settings.json-ban.
   */
  port?: number | undefined
  /** A daemon tokenje. Ha nincs megadva, véletlen. A desktop tartós tokent ad, ugyanezért. */
  token?: string | undefined
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { claudeDir, probe, pollMs = 3000, port: requestedPort = 0 } = options
  const token = options.token ?? randomBytes(16).toString('hex')

  const sessions = new SessionStore()
  const limits = new RateLimitStore()
  const decisions = new DecisionBroker()

  const app = createHookApp(
    token,
    {
      onNotification: (event) => {
        sessions.applyNotification(event)
      },
      onLifecycle: (event) => {
        sessions.applyLifecycle(event)
        // Kör vége vagy session vége: nála már nincs függő döntés — ha a VSCode-ban tiltottak,
        // erről csak így értesülünk (a tiltásnak nincs PostToolUse-a).
        if (event.kind !== 'start') decisions.sessionStopped(event.sessionId)
        void refresh()
      },
      onRateLimits: (received) => {
        limits.update(received)
        broadcast()
      },
      onPermissionRequest: (request) => decisions.hold(request),
      onPreToolUse: (event) => {
        decisions.preToolUse(event)
      },
      onPostToolUse: (event) => {
        decisions.postToolUse(event)
      },
      onSubagentStop: (event) => {
        decisions.subagentStopped(event.sessionId, event.agentId)
      },
    },
    // Diagnosztika, alapból kikapcsolva. A hookok valódi alakja nincs dokumentálva, és egy
    // rosszul olvasott mezőnév ugyanúgy néz ki, mint egy hiányzó adat — ezzel a nyers
    // törzs megnézhető anélkül, hogy a kódot kellene átírni hozzá.
    process.env['CLAUDESWITCHER_HOOK_LOG'],
  )

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: requestedPort }, () => {
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

  function state(): DaemonState {
    const pending = decisions.views()
    // Sessionönként a legrégebbi függő döntés: amíg az tart, a session várakozó.
    const pendingSince = new Map<string, number>()
    for (const view of pending) {
      const earlier = pendingSince.get(view.sessionId)
      if (earlier === undefined || view.createdAt < earlier) pendingSince.set(view.sessionId, view.createdAt)
    }
    return { sessions: sessions.views(pendingSince), rateLimits: limits.current(), decisions: pending }
  }

  // A SessionStore minden `apply*` híváskor jelez, akkor is, ha az állapot nem
  // változott — a másodperces poll így percenként hússzor küldene azonos
  // pillanatképet. A szűrés szándékosan itt van, nem a store-ban: a store dolga
  // annyi, hogy „történt valami", a hubé, hogy mit érdemes elküldeni. A
  // szerializált alak összehasonlítása pontos, ellentétben egy mezőnkénti
  // diffel, amit el lehet rontani.
  let lastBroadcast = ''
  function broadcast(): void {
    const message = JSON.stringify({ type: 'state', payload: state() })
    if (message === lastBroadcast) return
    lastBroadcast = message
    hub.broadcastRaw(message)
  }

  sessions.onChange(broadcast)
  decisions.onChange(broadcast)

  let refreshing: Promise<void> | undefined
  async function refresh(): Promise<void> {
    // Egyszerre csak egy szkennelés fusson; a fájlfigyelő sűrűn tüzelhet.
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      try {
        const snapshot = await scanSessions(claudeDir, probe)
        sessions.applySnapshot(snapshot.sessions, snapshot.activities)
        // Életjel MINDEN sikeres szkennelés után, akkor is, ha a pillanatkép nem változott.
        // Enélkül a kliens nem tudja megkülönböztetni azt, hogy „élünk, csak nincs
        // változás", attól, hogy „megállt a poll" — és épp a monitorozó eszköznél a
        // legrosszabb kimenet, ha egy állott lista élőnek látszik. Egy WebSocket-ping ezt
        // NEM fedné: a socket akkor is egészséges, ha a szkennelés halt meg.
        hub.broadcastRaw(JSON.stringify({ type: 'tick', at: Date.now() }))
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
      // kapcsolatok miatt a server.close() különben soha nem térne vissza.
      decisions.releaseAll()
      // Megvárjuk a futó szkennelést: leállás után ne maradjon dolgozó ígéret,
      // ami a processzt életben tartja vagy egy már lezárt hubba írna.
      await refreshing?.catch(() => undefined)
      await hub.close()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
