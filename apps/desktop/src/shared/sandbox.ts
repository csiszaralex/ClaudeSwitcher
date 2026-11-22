import { isRecord } from '@claudeswitcher/core/browser'

/**
 * The Bash field `dangerouslyDisableSandbox: true`: the command would run outside the sandbox. Only
 * an explicit `true` counts. The decision panel shows it in a red line (`renderer/DecisionContent.tsx`),
 * and the auto-accept mode never takes such a request (`shared/auto-accept.ts` `autoAcceptTakes`).
 * Compiled by both the main and the renderer projects, so it imports no `node:` module.
 */
export function sandboxDisabled(toolInput: unknown): boolean {
  return isRecord(toolInput) && toolInput['dangerouslyDisableSandbox'] === true
}
