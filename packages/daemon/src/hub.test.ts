import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hub } from './hub.js'

describe('Hub', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs an HTTP server error instead of letting it escape as an uncaught exception', async () => {
    // A ws a szerver `error` eseményét a WebSocketServeren újra kibocsátja. Figyelő nélkül ez
    // egy EventEmitter `error` lenne, ami dob, és a main processzben elkapatlan kivétel lenne.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = createServer()
    const hub = new Hub(server, 'token')
    const failure = new Error('accept failed')
    expect(() => server.emit('error', failure)).not.toThrow()
    expect(logged).toHaveBeenCalledWith('[hub] server error', failure)
    await hub.close()
  })
})
