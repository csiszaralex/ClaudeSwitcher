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
 * For an unreadable request (`readable === false`) only deny remains: the core's
 * `buildHookResponse` would reject allowing anyway.
 */
export function shortcutFor(kind: DecisionKind, key: string, readable: boolean): DecisionAction | undefined {
  const lower = key.toLowerCase()
  const action = ACTION_BUTTONS[kind].find((button) => button.key === lower)?.action
  return readable || action === 'deny' ? action : undefined
}

/**
 * A question whose questions could not be read (a changed `tool_input` shape). It cannot be
 * answered from here. The panel then offers the way out: the jump to VS Code, or a deny with a message.
 */
export function isUnreadableQuestion(decision: { kind: DecisionKind; questions: readonly unknown[] }): boolean {
  return decision.kind === 'question' && decision.questions.length === 0
}

/** True if the key belongs to a text field: the typing there is the field's, not the list's or the panel's. */
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
 * True if the target is a button, a `<summary>`, a link or a `role="button"` element, or is inside
 * one of them (e.g. the button's `<kbd>`). There Enter belongs to the element: it presses or opens
 * it. It walks the parent chain along `parentElement` and reads the role from the ARIA-reflecting
 * `role` property, so it can be tested without a DOM.
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

/** The submit key of the multi-line fields: Ctrl+Enter. A plain Enter starts a new line. */
export function isSubmitChord(event: { key: string; ctrlKey: boolean }): boolean {
  return event.key === 'Enter' && event.ctrlKey
}

/**
 * The `isSubmitChord` label on the submit button of the multi-line fields. Where the field is
 * single-line and Enter submits (the deny reason, the questions' free text), there is no label.
 */
export const SUBMIT_CHORD_LABEL = 'Ctrl+Enter'

/** The main process's `DecideResult`, checked, because anything can come over the IPC. */
export function readDecideResult(raw: unknown): DecideOutcome {
  if (isRecord(raw)) {
    if (raw['ok'] === true) return { ok: true }
    const reason = raw['reason']
    if (raw['ok'] === false && typeof reason === 'string') return { ok: false, reason }
  }
  return { ok: false, reason: 'Ismeretlen válasz a daemontól.' }
}

export interface OverlaySettings {
  /** Whether the overlay hides after the last waiting request is decided in the app. */
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
