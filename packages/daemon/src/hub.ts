import type { Server } from 'node:http'
import { DAEMON_WS_PATH, DAEMON_WS_TOKEN_PARAM } from '@claudeswitcher/core'
import { WebSocketServer, type WebSocket } from 'ws'
import { matchesSecret } from './token-compare.js'

/** A broadcast-only WS hub: the clients (the overlay) only receive, they never send. */
export class Hub {
  #wss: WebSocketServer
  #clients = new Set<WebSocket>()

  constructor(server: Server, token: string) {
    this.#wss = new WebSocketServer({
      server,
      path: DAEMON_WS_PATH,
      // Authentication BEFORE the handshake: a request without the token gets a 401 and never becomes
      // a WebSocket. With a close after the handshake (1008) a foreign client would first have got a
      // full connection.
      verifyClient: (info, callback) => {
        const url = new URL(info.req.url ?? '/', 'http://127.0.0.1')
        if (matchesSecret(url.searchParams.get(DAEMON_WS_TOKEN_PARAM), token)) callback(true)
        else callback(false, 401, 'Unauthorized')
      },
    })
    // ws re-emits the HTTP server's `error` event on the WebSocketServer (ws 8.22.0,
    // `addListeners(this._server, { error: ... })`). Without a listener an EventEmitter `error`
    // throws, which would be an uncaught exception in the main process. Here it is only logged; the
    // server's `error` listener in `startDaemon` does nothing any more after the listen.
    this.#wss.on('error', (error) => {
      console.error('[hub] server error', error)
    })
    // Only a client that passed `verifyClient`, so an authenticated one, gets here.
    this.#wss.on('connection', (socket) => {
      this.#clients.add(socket)
      socket.on('close', () => this.#clients.delete(socket))
      socket.on('error', () => this.#clients.delete(socket))
    })
  }

  /**
   * Sends an already serialised message.
   *
   * There is deliberately no `broadcast(payload: unknown)` convenience variant: the daemon serialises
   * itself so it can filter out identical snapshots, so such a method would have no caller. A second,
   * untested entry point without a caller is worse than none. If it is needed later, it is one line to
   * add back.
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
