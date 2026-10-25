import type { DecisionKind } from '@claudeswitcher/core'

export type DecisionAction = 'allow' | 'deny' | 'rule-project' | 'rule-machine' | 'session-edits'

/**
 * Billentyű → művelet, fajtánként. Kérdésnél nincs: azt csak az űrlappal lehet megválaszolni
 * (válasz nélkül nem engedhető tovább). Tervnél sincs: jóváhagyni a hookból nem lehet, az
 * elutasításhoz pedig visszajelzés kell — egy félreütött betű ne utasíthasson el egy tervet.
 */
const SHORTCUTS: Readonly<Record<DecisionKind, Readonly<Record<string, DecisionAction>>>> = {
  tool: { a: 'allow', d: 'deny', p: 'rule-project', g: 'rule-machine' },
  edit: { a: 'allow', d: 'deny', s: 'session-edits' },
  question: {},
  plan: {},
}

/**
 * Olvashatatlan kérésnél (`readable === false`) csak a tiltás marad: engedélyezést a core
 * `buildHookResponse` úgyis elutasítana.
 */
export function shortcutFor(kind: DecisionKind, key: string, readable: boolean): DecisionAction | undefined {
  const action = SHORTCUTS[kind][key.toLowerCase()]
  return readable || action === 'deny' ? action : undefined
}

/**
 * Kérdés, aminek a kérdéseit nem tudtuk kiolvasni (megváltozott `tool_input` alak). Válaszolni
 * rá innen nem lehet — a panel ilyenkor a kiutat kínálja: ugrás a VSCode-ba, vagy tiltás üzenettel.
 */
export function isUnreadableQuestion(decision: { kind: DecisionKind; questions: readonly unknown[] }): boolean {
  return decision.kind === 'question' && decision.questions.length === 0
}

/** Igaz, ha a billentyű egy szövegmezőé — ott a gépelés az övé, nem a listáé vagy a panelé. */
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

export type DecideOutcome = { ok: true } | { ok: false; reason: string }

/** A main processz `DecideResult`-ja, ellenőrizve — az IPC-n át bármi jöhet. */
export function readDecideResult(raw: unknown): DecideOutcome {
  if (typeof raw === 'object' && raw !== null) {
    const result = raw as { ok?: unknown; reason?: unknown }
    if (result.ok === true) return { ok: true }
    if (result.ok === false && typeof result.reason === 'string') return { ok: false, reason: result.reason }
  }
  return { ok: false, reason: 'Ismeretlen válasz a daemontól.' }
}

export interface OverlaySettings {
  /** Elrejtőzzön-e az overlay az utolsó várakozó appból hozott eldöntése után. */
  hideAfterLastDecision: boolean
}

/**
 * A main processz beállításai, ellenőrizve. Bármi másra az alapérték (elrejtés) jön — ugyanaz,
 * amit a main config is ad, ha a kulcs hiányzik.
 */
export function readOverlaySettings(raw: unknown): OverlaySettings {
  if (typeof raw === 'object' && raw !== null) {
    const { hideAfterLastDecision } = raw as { hideAfterLastDecision?: unknown }
    if (typeof hideAfterLastDecision === 'boolean') return { hideAfterLastDecision }
  }
  return { hideAfterLastDecision: true }
}
