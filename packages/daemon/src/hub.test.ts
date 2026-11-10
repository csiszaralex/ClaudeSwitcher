import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hub } from './hub.js'

describe('Hub', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs an HTTP server error instead of letting it escape as an uncaught exception', async () => {
    // ws re-emits the server's `error` event on the WebSocketServer. Without a listener this would be an
    // EventEmitter `error`, which throws, and an uncaught exception in the main process.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = createServer()
    const hub = new Hub(server, 'token')
    const failure = new Error('accept failed')
    expect(() => server.emit('error', failure)).not.toThrow()
    expect(logged).toHaveBeenCalledWith('[hub] server error', failure)
    await hub.close()
  })
})
