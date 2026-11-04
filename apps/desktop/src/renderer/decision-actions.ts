import type { DecisionKind } from '@claudeswitcher/core'
import { isRecord } from '@claudeswitcher/core/browser'
import type { DecideOutcome } from '../shared/overlay-channels.js'
import { DEFAULT_SETTINGS } from '../shared/settings.js'

export type DecisionAction = 'allow' | 'deny' | 'rule-project' | 'rule-machine' | 'session-edits'

/** One button of a decision's button row, with its key letter. */
export interface ActionButton {
  action: DecisionAction
  /** The key letter, lower case. The button shows it upper case. */
  key: string
  label: string
  /** Disabled until the panel is armed (key-guard.ts `isArmed`): the buttons that allow something. */
  needsArming: boolean
}

/** Deny is never armed-gated, and it is also the only button an unreadable request keeps. */
export const DENY_BUTTON: ActionButton = { action: 'deny', key: 'd', label: 'Tilt…', needsArming: false }

/**
 * The button row per kind, in display order; the keyboard shortcuts are the same table. A question
 * has none: only its form can answer it (it may not pass unanswered). A plan has none either: the
 * hook cannot approve it, rejecting it needs feedback, and a mistyped letter must not reject a plan.
 */
export const ACTION_BUTTONS: Readonly<Record<DecisionKind, readonly ActionButton[]>> = {
  tool: [
    { action: 'allow', key: 'a', label: 'Engedélyez', needsArming: true },
    DENY_BUTTON,
    { action: 'rule-project', key: 'p', label: 'Projekt-szabály…', needsArming: true },
    { action: 'rule-machine', key: 'g', label: 'Gépszintű szabály…', needsArming: true },
  ],
  edit: [
    { action: 'allow', key: 'a', label: 'Engedélyez', needsArming: true },
    DENY_BUTTON,
    { action: 'session-edits', key: 's', label: 'Erre a sessionre automatikusan', needsArming: true },
  ],
  question: [],
  plan: [],
}

/**
 * Olvashatatlan kérésnél (`readable === false`) csak a tiltás marad: engedélyezést a core
 * `buildHookResponse` úgyis elutasítana.
 */
export function shortcutFor(kind: DecisionKind, key: string, readable: boolean): DecisionAction | undefined {
  const lower = key.toLowerCase()
  const action = ACTION_BUTTONS[kind].find((button) => button.key === lower)?.action
  return readable || action === 'deny' ? action : undefined
}

/**
 * Kérdés, aminek a kérdéseit nem tudtuk kiolvasni (megváltozott `tool_input` alak). Válaszolni
 * rá innen nem lehet. A panel ilyenkor a kiutat kínálja: ugrás a VSCode-ba, vagy tiltás üzenettel.
 */
export function isUnreadableQuestion(decision: { kind: DecisionKind; questions: readonly unknown[] }): boolean {
  return decision.kind === 'question' && decision.questions.length === 0
}

/** Igaz, ha a billentyű egy szövegmezőé: ott a gépelés az övé, nem a listáé vagy a panelé. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable === true
  )
}

/**
 * Igaz, ha a cél egy gomb, egy `<summary>`, egy link vagy egy `role="button"` elem, vagy ezek
 * egyikén belül van (pl. a gomb `<kbd>`-ja). Ott az Enter az elemé: megnyomja, illetve nyitja.
 * A szülőláncot a `parentElement` mentén járja be, a szerepet az ARIA-tükrözésű `role`
 * tulajdonságból olvassa, így DOM nélkül is tesztelhető.
 */
export function isActivationTarget(target: unknown): boolean {
  let current: unknown = target
  while (typeof current === 'object' && current !== null) {
    const element = current as { tagName?: unknown; role?: unknown; parentElement?: unknown }
    if (element.tagName === 'BUTTON' || element.tagName === 'SUMMARY' || element.tagName === 'A') return true
    if (element.role === 'button') return true
    current = element.parentElement
  }
  return false
}

/** A többsoros mezők beküldő billentyűje: Ctrl+Enter. A sima Enter új sort kezd. */
export function isSubmitChord(event: { key: string; ctrlKey: boolean }): boolean {
  return event.key === 'Enter' && event.ctrlKey
}

/**
 * Az `isSubmitChord` felirata a többsoros mezők küldő gombján. Ahol a mező egysoros és az Enter
 * küld (a tiltás indoklása, a kérdések szabad szövege), ott nincs felirat.
 */
export const SUBMIT_CHORD_LABEL = 'Ctrl+Enter'

/** A main processz `DecideResult`-ja, ellenőrizve, mert az IPC-n át bármi jöhet. */
export function readDecideResult(raw: unknown): DecideOutcome {
  if (isRecord(raw)) {
    if (raw['ok'] === true) return { ok: true }
    const reason = raw['reason']
    if (raw['ok'] === false && typeof reason === 'string') return { ok: false, reason }
  }
  return { ok: false, reason: 'Ismeretlen válasz a daemontól.' }
}

export interface OverlaySettings {
  /** Elrejtőzzön-e az overlay az utolsó várakozó appból hozott eldöntése után. */
  hideAfterLastDecision: boolean
}

/**
 * The main process settings, checked. Anything else gets the default from `DEFAULT_SETTINGS`, the
 * same value the main config uses when the key is missing.
 */
export function readOverlaySettings(raw: unknown): OverlaySettings {
  if (isRecord(raw)) {
    const hideAfterLastDecision = raw['hideAfterLastDecision']
    if (typeof hideAfterLastDecision === 'boolean') return { hideAfterLastDecision }
  }
  return { hideAfterLastDecision: DEFAULT_SETTINGS.hideAfterLastDecision }
}
