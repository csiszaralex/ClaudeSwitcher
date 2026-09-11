import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

/** Broadcast-only WS hub: a kliensek (overlay) csak fogadnak, nem küldenek. */
export class Hub {
  #wss: WebSocketServer
  #clients = new Set<WebSocket>()

  constructor(server: Server, private readonly token: string) {
    this.#wss = new WebSocketServer({ server, path: '/ws' })
    this.#wss.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token') !== this.token) {
        socket.close(1008, 'unauthorized')
        return
      }
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
   * belépési pont rosszabb, mint a hiánya — ha később kell, egy sor visszatenni.
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
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
  }
}
