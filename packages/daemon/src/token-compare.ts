import { timingSafeEqual } from 'node:crypto'

/**
 * Igaz, ha a kapott érték bájtra pontosan a titok. A hook-szerver a teljes `Bearer <token>`
 * fejlécet, a WS hub a `token` paramétert hasonlítja vele, így a kettő nem térhet el egymástól.
 *
 * Állandó idejű összevetés (`timingSafeEqual`). Loopbacken egy 128 bites token ellen az időzítéses
 * támadás nem reális, ez higiénia. A hossz-ellenőrzés előtte kell, mert a `timingSafeEqual`
 * eltérő hosszú bufferekre dob. A hossz így kiderülhet, de az a tokennél rögzített (32 hexa jegy).
 */
export function matchesSecret(presented: string | null | undefined, secret: string): boolean {
  if (presented === undefined || presented === null) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(secret, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
