import type { MarkerTone } from './session-marker.js'

/**
 * The list's cleanup keys: Backspace clears a finish's ✓. Pure; App owns the keys (in its window
 * handler `onKey`, outside every text field, so Backspace still edits the search field and a deny
 * reason) and sends the change to the main process, which checks it against the daemon's state.
 */

/** The fields of a keydown the keys read. */
interface KeyLike {
  key: string
  repeat: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** A plain key: no Ctrl, Alt (AltGr) or Meta, and no Shift either, so Shift+Delete is not taken; not held. */
function isPlain(event: KeyLike, key: string): boolean {
  return event.key === key && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

/**
 * The key that clears the selected row's ✓: a plain Backspace (`isPlain`). No letter: the decision
 * panel's buttons are letters (`decision-actions.ts` `ACTION_BUTTONS`).
 */
export function isClearFinishKey(event: KeyLike): boolean {
  return isPlain(event, 'Backspace')
}

/** The markers of a finish's ✓: green unseen, blue seen (`session-marker.ts`). */
const FINISH_TONES: ReadonlySet<MarkerTone> = new Set<MarkerTone>(['done', 'seen'])

/**
 * Whether the row shows a finish's ✓ that Backspace clears: a row with a session whose marker is the
 * green or the blue ✓. Not a usage limit row (◷), whose turn finished too but which shows no ✓.
 */
export function showsFinishMark(row: { session?: unknown; marker: { tone: MarkerTone } }): boolean {
  return row.session !== undefined && FINISH_TONES.has(row.marker.tone)
}
