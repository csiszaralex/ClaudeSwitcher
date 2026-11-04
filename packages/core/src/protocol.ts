/**
 * A daemon WebSocket üzeneteinek (`state`, `tick`) protokollverziója. A daemon minden üzenetbe
 * beírja, a renderer minden más értéket eldob.
 *
 * Ma a daemon és a renderer egy Electron csomagban szállnak, tehát mindig egyeznek. A verzió azért
 * kell, hogy egy üzenetalak-változás ne csendben, mezőnként essen szét, ha a daemont egyszer külön
 * processzbe emelnék (spec §4: a modulhatár megvan hozzá). Ha az üzenet alakja összeférhetetlenül
 * változik, ezt kell növelni.
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
