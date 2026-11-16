import type { DecisionKind } from '@claudeswitcher/core'

/**
 * True for a request that asks for more than a yes or a no: a question to answer or a plan to
 * review. The list's waiting dot (`renderer/session-marker.ts`) and the tray icon
 * (`main/tray-state.ts`) show these in their own colour. An exhaustive switch over core's
 * `DecisionKind`, so a new kind must be classified here.
 */
export function isChoiceKind(kind: DecisionKind): boolean {
  switch (kind) {
    case 'question':
    case 'plan':
      return true
    case 'tool':
    case 'edit':
      return false
  }
}
