import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import type { ProcessProbe, RateLimits, SessionView } from '@claudeswitcher/core'
import { createHookApp } from './hook-server.js'
import { Hub } from './hub.js'
import { RateLimitStore } from './rate-limits.js'
import { scanSessions } from './scanner.js'
import { SessionStore } from './session-store.js'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
}

export interface Daemon {
  readonly port: number
  readonly token: string
  state(): DaemonState
  refresh(): Promise<void>
  stop(): Promise<void>
}

export interface DaemonOptions {
  claudeDir: string
  probe: ProcessProbe
  /** Poll periódus ms-ben. 0 kikapcsolja (tesztekhez). */
  pollMs?: number
  /**
   * A port, amire a daemon köt. 0: ideiglenes (tesztekhez). A desktop fix portot ad, mert a
   * telepített hookok és a statusLine egy rögzített URL-t kapnak a settings.json-ban.
   */
  port?: number
  /** A daemon tokenje. Ha nincs megadva, véletlen. A desktop tartós tokent ad, ugyanezért. */
  token?: string
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { claudeDir, probe, pollMs = 3000, port: requestedPort = 0 } = options
  const token = options.token ?? randomBytes(16).toString('hex')

  const sessions = new SessionStore()
  const limits = new RateLimitStore()

  const app = createHookApp(token, {
    onNotification: (event) => sessions.applyNotification(event),
    onLifecycle: (event) => {
      sessions.applyLifecycle(event)
      void refresh()
    },
    onRateLimits: (received) => {
      limits.update(received)
      broadcast()
    },
  })

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: requestedPort }, () => resolve(s))
    // Foglalt porton a listen `error` eseményt emittál. Kezelő nélkül ez elkapatlan kivétel
    // lenne; így a startDaemon elutasít, a desktop pedig indulási hibadialógust mutat.
    s.on('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  // A @hono/node-server `serve()` egy node:http Servert ad vissza a
  // default (nem HTTP/2) konfigurációval; a WS hub ezen osztozik.
  const hub = new Hub(server as HttpServer, token)

  function state(): DaemonState {
    return { sessions: sessions.views(), rateLimits: limits.current() }
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

  let refreshing: Promise<void> | undefined
  async function refresh(): Promise<void> {
    // Egyszerre csak egy szkennelés fusson; a fájlfigyelő sűrűn tüzelhet.
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      try {
        const snapshot = await scanSessions(claudeDir, probe)
        sessions.applySnapshot(snapshot.sessions, snapshot.activities)
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
    async stop() {
      if (timer !== undefined) clearInterval(timer)
      // Megvárjuk a futó szkennelést: leállás után ne maradjon dolgozó ígéret,
      // ami a processzt életben tartja vagy egy már lezárt hubba írna.
      await refreshing?.catch(() => undefined)
      await hub.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
