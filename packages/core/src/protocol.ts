/**
 * The protocol version of the daemon's WebSocket messages (`state`, `tick`). The daemon writes it
 * into every message, and the renderer drops a message with any other value.
 *
 * Today the daemon and the renderer ship in one Electron package, so they always match. The version
 * exists so that a change in the message shape fails loudly rather than silently, field by field,
 * if the daemon is ever moved into its own process (design doc, section 4: the module boundary is
 * already in place). Increment it on any incompatible change to the message shape.
 */
export const DAEMON_PROTOCOL = 1

/** The daemon listens on loopback only: the hook server and the WebSocket share this host. */
export const DAEMON_HOST = '127.0.0.1'

/** The WebSocket path on the daemon's server. */
export const DAEMON_WS_PATH = '/ws'

/** The query parameter that carries the daemon token on the WebSocket upgrade. */
export const DAEMON_WS_TOKEN_PARAM = 'token'

/** The WebSocket URL the renderer connects to. The token is hex, so it needs no encoding. */
export function daemonWsUrl(port: number, token: string): string {
  return `ws://${DAEMON_HOST}:${String(port)}${DAEMON_WS_PATH}?${DAEMON_WS_TOKEN_PARAM}=${token}`
}
