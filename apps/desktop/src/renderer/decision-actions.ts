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

export function shortcutFor(kind: DecisionKind, key: string): DecisionAction | undefined {
  return SHORTCUTS[kind][key.toLowerCase()]
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
