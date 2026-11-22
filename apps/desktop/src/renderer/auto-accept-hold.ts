/**
 * The overlay's side of the auto-accept mode (`shared/auto-accept.ts`): the key that turns it on and
 * off on the selected row (Shift+A held for `AUTO_ACCEPT_HOLD_MS`), the countdown while it is held,
 * and the row's tag. Pure; App owns the hold (in its window handler `onKey`, outside every text
 * field, `decision-actions.ts` `isTypingTarget`, and not in the peek), cancels it on the key's
 * release, a blur, a `shown` or a change of the selected row, and sends the change to the main
 * process (`OVERLAY_CHANNELS.setAutoAccept`), which keeps the mode.
 */

/** How long Shift+A must be held on a row to turn its session's mode on or off. The owner's choice. */
export const AUTO_ACCEPT_HOLD_MS = 3000

/** A keydown event as the hold reads it. */
interface HoldKey {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * Shift+A, without Ctrl, Alt or Meta (AltGr on the Hungarian layout arrives as Ctrl+Alt). The key is
 * compared lower-cased, as the panel's letters are (`decision-actions.ts` `shortcutFor`), so Caps
 * Lock does not matter. The panel's letters skip every key with Shift (`key-guard.ts`
 * `shortcutAllowed`), so this key never allows a request.
 */
export function isAutoAcceptKey(event: HoldKey): boolean {
  return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'a'
}

/** A keyup that ends the hold early: the A or the Shift released. Releasing early changes nothing. */
export function endsHold(event: { key: string }): boolean {
  return event.key === 'Shift' || event.key.toLowerCase() === 'a'
}

/** A running hold: the row's session, whether completing it turns the mode on or off, and when it began. */
export interface AutoAcceptHold {
  sessionId: string
  turnOn: boolean
  startedAt: number
}

/** The whole seconds left until the hold completes, rounded up: 3, 2, 1, then 0 once it is due. */
export function holdSecondsLeft(hold: AutoAcceptHold, now: number): number {
  return Math.max(0, Math.ceil((hold.startedAt + AUTO_ACCEPT_HOLD_MS - now) / 1000))
}

/** The hold's countdown in the row, in place of the row's text. */
export function holdText(hold: AutoAcceptHold, now: number): string {
  const action = hold.turnOn ? 'bekapcsolása' : 'kikapcsolása'
  return `Automatikus engedélyezés ${action}: még ${String(holdSecondsLeft(hold, now))} mp, tartsd lenyomva`
}

/** The tag of a row in the mode: how many requests the mode allowed since it was turned on. */
export function autoTagText(allowed: number): string {
  return `auto ${String(allowed)}`
}

/** The tag's tooltip. */
export function autoTagTitle(allowed: number): string {
  return (
    `Automatikus engedélyezés: bekapcsolása óta ${String(allowed)} kérést engedélyezett. ` +
    `Kikapcsolás: Shift+A nyomva tartva ${String(AUTO_ACCEPT_HOLD_MS / 1000)} mp-ig.`
  )
}
