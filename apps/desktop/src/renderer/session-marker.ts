import type { SessionStatus } from '@claudeswitcher/core'
import { PERMISSION_RELEASE_AFTER_MS } from '@claudeswitcher/core/browser'

/** A sor eleji jel öt állapota; a CSS `tone-…` osztálya adja a színét. */
export type MarkerTone = 'waiting' | 'released' | 'working' | 'done' | 'idle'

export interface StatusMarker {
  tone: MarkerTone
  glyph: string
  /** Magyar tooltip — a szín és a jel magában nem magyarázza meg magát. */
  title: string
}

// Az alak is különbözik, nem csak a szín: színtévesztő szemmel is olvasható maradjon.
const MARKERS: Readonly<Record<MarkerTone, StatusMarker>> = {
  waiting: { tone: 'waiting', glyph: '●', title: 'Válaszra vár' },
  released: {
    tone: 'released',
    glyph: '◆',
    title: `Az app elengedte (${PERMISSION_RELEASE_AFTER_MS / 1000} mp) — a VSCode-ban vagy a telefonon még dönthetsz`,
  },
  working: { tone: 'working', glyph: '◐', title: 'Dolgozik' },
  done: { tone: 'done', glyph: '✓', title: 'Épp végzett' },
  idle: { tone: 'idle', glyph: '○', title: 'Tétlen' },
}

/**
 * A session állapotjele. A `decisions` a session SAJÁT függő döntései.
 *
 * Sorrend: egy appból még eldönthető (nem elengedett) kérés a legerősebb jel; ha csak elengedett
 * van, az külön állapot, mert onnan az app már nem dönthet. Utána jön a Notification-várakozás,
 * a futás, és az „épp végzett" — ez csak akkor, ha a session se nem fut, se nem vár: egy régi
 * `stoppedAt` mellett újra dolgozó session nem „végzett".
 */
export function statusMarker(
  view: { status: SessionStatus; stoppedAt?: number | undefined },
  decisions: readonly { released: boolean }[],
): StatusMarker {
  if (decisions.some((d) => !d.released)) return MARKERS.waiting
  if (decisions.length > 0) return MARKERS.released
  if (view.status === 'waiting') return MARKERS.waiting
  if (view.status === 'working') return MARKERS.working
  if (view.stoppedAt !== undefined) return MARKERS.done
  return MARKERS.idle
}

/**
 * Van-e a sessionnek Remote Control kapcsolata (telefonról is elérhető). A registry-rekord
 * `bridgeSessionId`-ja mondja meg; futásidőben bármi lehet, ezért `unknown`.
 */
export function hasRemoteControl(view: { bridgeSessionId?: unknown }): boolean {
  return typeof view.bridgeSessionId === 'string' && view.bridgeSessionId.trim() !== ''
}
