import type { DecisionKind, SessionStatus } from '@claudeswitcher/core'
import { PERMISSION_RELEASE_AFTER_MS } from '@claudeswitcher/core/browser'
import { isChoiceKind } from '../shared/request-kind.js'
import { finishState, type SeenFinishes } from '../shared/session-finished.js'

/**
 * The states of the mark at the start of the row; the CSS class `tone-…` gives its color. `waiting`
 * is a yes/no request (or a Notification wait), `choice` a request that asks for more
 * (`isChoiceKind`): the same dot in another color. `done` is a finish the user has not seen yet,
 * `seen` one they have (`finishState`): the same ✓ in another color.
 */
export type MarkerTone = 'waiting' | 'choice' | 'released' | 'working' | 'done' | 'seen' | 'idle'

export interface StatusMarker {
  tone: MarkerTone
  glyph: string
  /** A Hungarian tooltip: the color and the glyph do not explain themselves. */
  title: string
}

// The shape differs too, not just the color: it stays readable for a color-blind eye.
const MARKERS: Readonly<Record<MarkerTone, StatusMarker>> = {
  waiting: { tone: 'waiting', glyph: '●', title: 'Válaszra vár' },
  // The same dot: the kind of the request is told by the color and the tooltip, not the shape.
  choice: { tone: 'choice', glyph: '●', title: 'Választásra vár' },
  // Its tooltip depends on Remote Control, so `statusMarker` builds it (`releasedMarker`).
  released: { tone: 'released', glyph: '◆', title: '' },
  working: { tone: 'working', glyph: '◐', title: 'Dolgozik' },
  done: { tone: 'done', glyph: '✓', title: 'Épp végzett' },
  // The same ✓: whether the finish was seen is told by the color and the tooltip, not the shape.
  seen: { tone: 'seen', glyph: '✓', title: 'Végzett, már megnyitottad' },
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
 * The session's status marker. `decisions` are the session's OWN pending decisions, `seen` the
 * finishes the user has seen (`useSeenFinishes`).
 *
 * Order: a request the app can still decide (not released) is the strongest sign, in the choice
 * color if one of them asks for more than a yes or a no; if there are only released ones, that is a
 * state of its own, because from there the app can no longer decide.
 * Then come the Notification wait, running, and "just finished" (`finishState`, the rule the tray's
 * done mark follows too): green while unseen, blue once seen.
 */
export function statusMarker(
  view: { sessionId: string; status: SessionStatus; stoppedAt?: number | undefined; bridgeSessionId?: unknown },
  decisions: readonly { released: boolean; kind: DecisionKind }[],
  seen: SeenFinishes,
): StatusMarker {
  const held = decisions.filter((d) => !d.released)
  if (held.some((d) => isChoiceKind(d.kind))) return MARKERS.choice
  if (held.length > 0) return MARKERS.waiting
  if (decisions.length > 0) return releasedMarker(hasRemoteControl(view))
  if (view.status === 'waiting') return MARKERS.waiting
  if (view.status === 'working') return MARKERS.working
  switch (finishState(view, seen)) {
    case 'unseen':
      return MARKERS.done
    case 'seen':
      return MARKERS.seen
    case 'none':
      return MARKERS.idle
  }
}

/**
 * Whether the session has a Remote Control connection (reachable from a phone too). The registry
 * record's `bridgeSessionId` tells; at runtime it can be anything, hence `unknown`.
 */
export function hasRemoteControl(view: { bridgeSessionId?: unknown }): boolean {
  return typeof view.bridgeSessionId === 'string' && view.bridgeSessionId.trim() !== ''
}
