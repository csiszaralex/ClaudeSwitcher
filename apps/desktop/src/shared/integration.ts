/**
 * The states of the Claude Code integration in `settings.json`, as one list: `main/setup.ts`
 * `HookInstallState` is built from it, and the setup window checks the state it receives against it.
 * Compiled by both the main and the renderer projects, so it imports no `node:` module.
 */
export const INTEGRATION_KINDS = ['current', 'stale', 'not-installed', 'unknown'] as const

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number]

export function isIntegrationKind(value: unknown): value is IntegrationKind {
  return INTEGRATION_KINDS.some((kind) => kind === value)
}
