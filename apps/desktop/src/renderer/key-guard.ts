/**
 * A döntési panel betűjeleinek őre: mikor dönthet egy leütött betű.
 *
 * A betűjelek egyetlen leütéssel döntenek, és a panel a felhasználó keze alatt cserélődhet: a
 * kérés máshol lezárul, vagy egy döntés után a kijelölés a következő várakozóra lép. Ezért a
 * friss panel nem élesedik azonnal, a szövegmezőbe gépelt mondat folytatása nem dönt, és a
 * nyomva tartott billentyű ismétlése soha nem számít leütésnek.
 */

/** Ennyi ideig nem hatnak a betűjelek (és nem nyomhatók az engedélyező gombok) a panel megjelenése után. */
export const SHORTCUT_ARM_MS = 400

/** Ennyi ideig nem hatnak a betűjelek az utolsó, szövegmezőbe ütött billentyű után. */
export const TYPING_COOLDOWN_MS = 1500

/** Egy keydown esemény az őr szemével. */
export interface ShortcutKey {
  /** A böngésző automatikus ismétlése (nyomva tartott billentyű). */
  repeat: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  /** A célja szövegmező (`isTypingTarget`). */
  typingTarget: boolean
}

export interface ShortcutClock {
  /** Az az időpont, amely előtt a betűjelek nem hatnak (`armUntil`). */
  armedAt: number
  /** Az utolsó olyan keydown ideje, amelynek a célja szövegmező volt; `undefined`, ha még nem volt ilyen. */
  lastTypedAt: number | undefined
  now: number
}

/**
 * Az App billentyű-előzménye, amit a panel olvas. Ref-ben él, nem állapotban: a panel
 * keydown-kezelője még azelőtt lássa a friss értéket, hogy a React újrarenderelt volna.
 */
export interface KeyHistory {
  /** Az utolsó `overlay:shown` utáni élesedés időpontja (`armUntil`); 0, ha még nem jelent meg. */
  shownArmedAt: number
  /** Lásd `ShortcutClock.lastTypedAt`. */
  lastTypedAt: number | undefined
}

/** Az élesedés időpontja egy `now`-kor megjelent panelnél vagy overlaynél. */
export function armUntil(now: number): number {
  return now + SHORTCUT_ARM_MS
}

export function isArmed(armedAt: number, now: number): boolean {
  return now >= armedAt
}

/**
 * Hathat-e a betűjel. Minden feltételnek teljesülnie kell:
 * - nem ismétlés;
 * - nincs Ctrl, Alt vagy Meta (a magyar kiosztás AltGr-je Ctrl+Altként érkezik, és egy `@` ne döntsön);
 * - a célja nem szövegmező;
 * - a panel élesedett;
 * - a legutóbbi szövegmezős gépelés óta eltelt `TYPING_COOLDOWN_MS`.
 */
export function shortcutAllowed(key: ShortcutKey, clock: ShortcutClock): boolean {
  if (key.repeat || key.ctrlKey || key.altKey || key.metaKey || key.typingTarget) return false
  if (!isArmed(clock.armedAt, clock.now)) return false
  return clock.lastTypedAt === undefined || clock.now - clock.lastTypedAt >= TYPING_COOLDOWN_MS
}
