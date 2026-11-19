import type { DecisionKind, SessionStatus } from '@claudeswitcher/core'
import { PERMISSION_RELEASE_AFTER_MS, UNREADABLE_REQUEST } from '@claudeswitcher/core/browser'
import { capitalized } from '../shared/hungarian-text.js'
import { sessionHost, type SessionHost } from '../shared/request-source.js'
import type { LinkedSession } from '../shared/prompt-links.js'
import { finishState, waitsOn, type SeenFinishes } from '../shared/session-finished.js'
import { sessionState } from '../shared/session-state.js'
import { sessionUsageLimit } from './usage-limit.js'

/**
 * The states of the mark at the start of the row; the CSS class `tone-…` gives its color. `waiting`
 * is a yes/no request (or a Notification wait), `choice` a request that asks for more
 * (`isChoiceKind`): the same dot in another color. `done` is a finish the user has not seen yet,
 * `seen` one they have (`finishState`): the same ✓ in another color. `limit` is a session whose turn
 * ended at the account's usage limit (`sessionUsageLimit`). `waits-on` is a session whose turn
 * ended while sessions it prompted still work on its message (`waitsOn`).
 */
export type MarkerTone =
  | 'waiting'
  | 'choice'
  | 'released'
  | 'working'
  | 'waits-on'
  | 'done'
  | 'seen'
  | 'limit'
  | 'idle'

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
  // The row's text names the sessions it waits on (`format.ts` `waitsOnText`).
  'waits-on': { tone: 'waits-on', glyph: '◌', title: 'Végzett, de vár a sessionökre, amelyeket megkért' },
  done: { tone: 'done', glyph: '✓', title: 'Épp végzett' },
  // The same ✓: whether the finish was seen is told by the color and the tooltip, not the shape.
  seen: { tone: 'seen', glyph: '✓', title: 'Végzett, már megnyitottad' },
  // The row's text says which limit and until when (`usageLimitRowText`).
  limit: { tone: 'limit', glyph: '◷', title: 'Használati limit miatt állt meg' },
  idle: { tone: 'idle', glyph: '○', title: 'Tétlen' },
}

/**
 * Where a released request can be decided. The one place the tooltip's and the decision panel's
 * text come from: the session's own host (`sessionHost`), and the phone only with Remote Control
 * (`hasRemoteControl`).
 */
export function releasedMessage(remoteControl: boolean, host: SessionHost): string {
  const where = capitalized(host.inside)
  return remoteControl ? `${where} vagy a telefonon még dönthetsz.` : `${where} még dönthetsz.`
}

/**
 * The decision panel's text for an unreadable request: the core's host-neutral `UNREADABLE_REQUEST`,
 * then the way out at the session's own host (`sessionHost`).
 */
export function unreadableMessage(host: SessionHost): string {
  return `${UNREADABLE_REQUEST} Tilthatod, vagy dönts ${host.inside}.`
}

/**
 * The notice of a session that waits for a decision the app holds no request for (`rows.ts`
 * `waitsOutsideApp`): only the session's own prompt can decide it.
 */
export function outsideAppMessage(host: SessionHost): string {
  return `${capitalized(host.inside)} vár jóváhagyásra. Az appból ezt nem lehet eldönteni (az app újraindult, vagy a kérés nem hozzá érkezett).`
}

function releasedMarker(remoteControl: boolean, host: SessionHost): StatusMarker {
  return {
    ...MARKERS.released,
    title: `Az app elengedte (${String(PERMISSION_RELEASE_AFTER_MS / 1000)} mp). ${releasedMessage(remoteControl, host)}`,
  }
}

/**
 * The session's status marker. `decisions` are the session's OWN pending decisions, `seen` the
 * finishes the user has seen (`useSeenFinishes`).
 *
 * Order: first the steps the tray icon shows too (`sessionState`, their one home): a request the
 * app can still decide (not released) is the strongest sign, in the choice color if one of them asks
 * for more than a yes or a no; if there are only released ones, that is a state of its own, because
 * from there the app can no longer decide; then the Notification wait, running, and waiting on the
 * sessions it prompted (`waitsOn`; `sessions` are all the live sessions).
 * Then come the usage limit (`sessionUsageLimit`: a turn the limit
 * ended has a `stoppedAt` too, from the `StopFailure` hook, and the limit says more than the ✓), and
 * "just finished" (`finishState`, the rule the tray's done mark follows too): green while unseen,
 * blue once seen.
 */
export function statusMarker(
  view: {
    sessionId: string
    status: SessionStatus
    stoppedAt?: number | undefined
    bridgeSessionId?: unknown
    entrypoint?: string | undefined
    messagingSocketPath?: string | undefined
    activity?: { usageLimit?: unknown } | undefined
  },
  decisions: readonly { released: boolean; kind: DecisionKind }[],
  seen: SeenFinishes,
  sessions: readonly LinkedSession[],
): StatusMarker {
  switch (sessionState(view.status, decisions, waitsOn(view, sessions).length > 0)) {
    case 'choice':
      return MARKERS.choice
    case 'yes-no':
      return MARKERS.waiting
    case 'released':
      return releasedMarker(hasRemoteControl(view), sessionHost(view.entrypoint))
    case 'working':
      return MARKERS.working
    case 'waits-on':
      return MARKERS['waits-on']
    case 'rest':
      break
  }
  if (sessionUsageLimit(view) !== undefined) return MARKERS.limit
  switch (finishState(view, seen, sessions)) {
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
