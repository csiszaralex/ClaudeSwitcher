import { timingSafeEqual } from 'node:crypto'

/**
 * True if the presented value is the secret, byte for byte. The hook server compares the whole
 * `Bearer <token>` header with it, the WS hub the `token` parameter, so the two cannot drift apart.
 *
 * A constant-time comparison (`timingSafeEqual`). On loopback a timing attack against a 128-bit
 * token is not realistic; this is hygiene. The length check must come first, because
 * `timingSafeEqual` throws on buffers of different length. That can reveal the length, but for the
 * token it is fixed (32 hex digits).
 */
export function matchesSecret(presented: string | null | undefined, secret: string): boolean {
  if (presented === undefined || presented === null) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(secret, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
