/**
 * The guard on the decision panel's key letters: when a pressed letter may decide.
 *
 * The key letters decide with a single keystroke, and the panel can change under the user's hand:
 * the request is settled elsewhere, or after a decision the selection steps to the next waiting
 * one. So a fresh panel does not arm at once, the rest of a sentence typed into a text field does
 * not decide, and the auto-repeat of a held key never counts as a keystroke.
 */

/** For this long after the panel appears the key letters have no effect (and the allowing buttons cannot be pressed). */
export const SHORTCUT_ARM_MS = 400

/** For this long after the last key typed into a text field the key letters have no effect. */
export const TYPING_COOLDOWN_MS = 1500

/** A keydown event as the guard sees it. */
export interface ShortcutKey {
  /** The browser's auto-repeat (a held key). */
  repeat: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  /** Its target is a text field (`isTypingTarget`). */
  typingTarget: boolean
}

export interface ShortcutClock {
  /** The time before which the key letters have no effect (`armUntil`). */
  armedAt: number
  /** The time of the last keydown whose target was a text field; `undefined` if there was none yet. */
  lastTypedAt: number | undefined
  now: number
}

/**
 * App's key history, which the panel reads. It lives in a ref, not in state: the panel's keydown
 * handler must see the fresh value even before React has re-rendered.
 */
export interface KeyHistory {
  /** The arming time after the last `overlay:shown` (`armUntil`); 0 if the overlay has not appeared yet. */
  shownArmedAt: number
  /** See `ShortcutClock.lastTypedAt`. */
  lastTypedAt: number | undefined
}

/** The arming time for a panel or overlay that appeared at `now`. */
export function armUntil(now: number): number {
  return now + SHORTCUT_ARM_MS
}

export function isArmed(armedAt: number, now: number): boolean {
  return now >= armedAt
}

/** Whether the user typed into a text field in the last `TYPING_COOLDOWN_MS`. */
export function recentlyTyped(lastTypedAt: number | undefined, now: number): boolean {
  return lastTypedAt !== undefined && now - lastTypedAt < TYPING_COOLDOWN_MS
}

/**
 * Whether the key letter may take effect. Every condition must hold:
 * - not an auto-repeat;
 * - no Ctrl, Alt or Meta (AltGr on the Hungarian layout arrives as Ctrl+Alt, and an `@` must not decide);
 * - its target is not a text field;
 * - the panel is armed;
 * - `TYPING_COOLDOWN_MS` has passed since the last typing in a text field.
 */
export function shortcutAllowed(key: ShortcutKey, clock: ShortcutClock): boolean {
  if (key.repeat || key.ctrlKey || key.altKey || key.metaKey || key.typingTarget) return false
  if (!isArmed(clock.armedAt, clock.now)) return false
  return !recentlyTyped(clock.lastTypedAt, clock.now)
}
