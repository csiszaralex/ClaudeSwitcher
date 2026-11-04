import { randomBytes } from 'node:crypto'

/**
 * The daemon token's format, owned here because the token is the daemon's credential: 16 random
 * bytes as 32 lowercase hex digits. The hooks present it as `Bearer <token>`, the overlay as the
 * WebSocket query parameter; `matchesSecret` compares both.
 */
const TOKEN_BYTES = 16

const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${String(TOKEN_BYTES * 2)}}$`)

/** A fresh random daemon token. */
export function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/** True if `value` has the daemon token's format. */
export function isToken(value: string): boolean {
  return TOKEN_PATTERN.test(value)
}
