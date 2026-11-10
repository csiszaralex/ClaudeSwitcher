import type { SessionStatus } from '@claudeswitcher/core'
import { PERMISSION_RELEASE_AFTER_MS } from '@claudeswitcher/core/browser'

/** The five states of the mark at the start of the row; the CSS class `tone-…` gives its color. */
type MarkerTone = 'waiting' | 'released' | 'working' | 'done' | 'idle'

export interface StatusMarker {
  tone: MarkerTone
  glyph: string
  /** A Hungarian tooltip: the color and the glyph do not explain themselves. */
  title: string
}

// The shape differs too, not just the color: it stays readable for a color-blind eye.
const MARKERS: Readonly<Record<MarkerTone, StatusMarker>> = {
  waiting: { tone: 'waiting', glyph: '●', title: 'Válaszra vár' },
  // Its tooltip depends on Remote Control, so `statusMarker` builds it (`releasedMarker`).
  released: { tone: 'released', glyph: '◆', title: '' },
  working: { tone: 'working', glyph: '◐', title: 'Dolgozik' },
  done: { tone: 'done', glyph: '✓', title: 'Épp végzett' },
  idle: { tone: 'idle', glyph: '○', title: 'Tétlen' },
}

/**
 * Where a released request can be decided. The one place the tooltip's and the decision panel's
 * text come from: the phone is an option only with Remote Control (`hasRemoteControl`).
 */
export function releasedMessage(remoteControl: boolean): string {
  return remoteControl ? 'A VSCode-ban vagy a telefonon még dönthetsz.' : 'A VSCode-ban még dönthetsz.'
}

function releasedMarker(remoteControl: boolean): StatusMarker {
  return {
    ...MARKERS.released,
    title: `Az app elengedte (${String(PERMISSION_RELEASE_AFTER_MS / 1000)} mp). ${releasedMessage(remoteControl)}`,
  }
}

/**
 * The session's status marker. `decisions` are the session's OWN pending decisions.
 *
 * Order: a request the app can still decide (not released) is the strongest sign; if there are
 * only released ones, that is a state of its own, because from there the app can no longer decide.
 * Then come the Notification wait, running, and "just finished", the last only if the session
 * neither runs nor waits: a session working again next to an old `stoppedAt` has not "finished".
 */
export function statusMarker(
  view: { status: SessionStatus; stoppedAt?: number | undefined; bridgeSessionId?: unknown },
  decisions: readonly { released: boolean }[],
): StatusMarker {
  if (decisions.some((d) => !d.released)) return MARKERS.waiting
  if (decisions.length > 0) return releasedMarker(hasRemoteControl(view))
  if (view.status === 'waiting') return MARKERS.waiting
  if (view.status === 'working') return MARKERS.working
  if (view.stoppedAt !== undefined) return MARKERS.done
  return MARKERS.idle
}

/**
 * Whether the session has a Remote Control connection (reachable from a phone too). The registry
 * record's `bridgeSessionId` tells; at runtime it can be anything, hence `unknown`.
 */
export function hasRemoteControl(view: { bridgeSessionId?: unknown }): boolean {
  return typeof view.bridgeSessionId === 'string' && view.bridgeSessionId.trim() !== ''
}
