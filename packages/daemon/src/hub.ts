import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { matchesSecret } from './token-compare.js'

/** Broadcast-only WS hub: a kliensek (overlay) csak fogadnak, nem küldenek. */
export class Hub {
  #wss: WebSocketServer
  #clients = new Set<WebSocket>()

  constructor(server: Server, token: string) {
    this.#wss = new WebSocketServer({
      server,
      path: '/ws',
      // A hitelesítés a kézfogás ELŐTT: egy token nélküli kérés 401-et kap, és soha nem lesz
      // belőle WebSocket. A kézfogás utáni bezárás (1008) mellett egy idegen kliens előbb egy
      // teljes kapcsolatot kapott volna.
      verifyClient: (info, callback) => {
        const url = new URL(info.req.url ?? '/', 'http://127.0.0.1')
        if (matchesSecret(url.searchParams.get('token'), token)) callback(true)
        else callback(false, 401, 'Unauthorized')
      },
    })
    // A ws a HTTP szerver `error` eseményét a WebSocketServeren újra kibocsátja (ws 8.22.0,
    // `addListeners(this._server, { error: ... })`). Figyelő nélkül egy EventEmitter `error`
    // dob, ami a main processzben elkapatlan kivétel lenne. Itt csak naplózzuk; a szerver
    // `error` figyelője a `startDaemon`-ban a listen után már nem tesz semmit.
    this.#wss.on('error', (error) => {
      console.error('[hub] server error', error)
    })
    // Ide már csak a `verifyClient`-en átjutott, tehát hitelesített kliens ér.
    this.#wss.on('connection', (socket) => {
      this.#clients.add(socket)
      socket.on('close', () => this.#clients.delete(socket))
      socket.on('error', () => this.#clients.delete(socket))
    })
  }

  /**
   * Már szerializált üzenetet küld.
   *
   * Szándékosan nincs `broadcast(payload: unknown)` kényelmi változat: a daemon
   * maga szerializál, hogy az azonos pillanatképeket ki tudja szűrni, tehát egy
   * ilyen metódusnak nem lenne hívója. Egy hívó nélküli, teszteletlen második
   * belépési pont rosszabb, mint a hiánya. Ha később kell, egy sor visszatenni.
   */
  broadcastRaw(message: string): void {
    for (const client of this.#clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(message)
        } catch (error) {
          console.error('[hub] send failed', error)
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.terminate()
    this.#clients.clear()
    await new Promise<void>((resolve) => {
      this.#wss.close(() => {
        resolve()
      })
    })
  }
}
