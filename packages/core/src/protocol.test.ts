import { describe, expect, it } from 'vitest'
import { daemonWsUrl } from './protocol.js'

describe('daemonWsUrl', () => {
  it('builds the loopback WebSocket URL with the token as a query parameter', () => {
    expect(daemonWsUrl(47821, '0123456789abcdef0123456789abcdef')).toBe(
      'ws://127.0.0.1:47821/ws?token=0123456789abcdef0123456789abcdef',
    )
  })
})
