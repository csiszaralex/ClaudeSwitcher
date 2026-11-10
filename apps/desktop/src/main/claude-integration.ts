import { readFile } from 'node:fs/promises'
import {
  DAEMON_HOST,
  HOOK_CONTRACT,
  LEGACY_HOOK_CONTRACT,
  OUR_HOOK_PATHS,
  hookPath,
  isNotFoundError,
  isRecord,
  transformSettingsFile,
  userSettingsPath,
  type HookContractEntry,
} from '@claudeswitcher/core'
import type { IntegrationKind } from '../shared/integration.js'
import { DAEMON_PORT } from './daemon-port.js'

export { DAEMON_PORT } from './daemon-port.js'

export interface IntegrationOptions {
  port: number
  token: string
}

export interface IntegrationResult {
  settings: Record<string, unknown>
  /** Human-readable descriptions of what was deliberately not overwritten. */
  conflicts: string[]
}

/**
 * The installed hooks and the retired ones come from the core contract (`HOOK_CONTRACT`,
 * `LEGACY_HOOK_CONTRACT`). The failure events (`PostToolUseFailure`, `StopFailure`) get the route
 * of their success counterpart, so they match `OUR_HOOK_PATHS`, and install and uninstall handle
 * them without extra code.
 */
const LEGACY_EVENTS: readonly string[] = LEGACY_HOOK_CONTRACT.map((hook) => hook.event)

const TOKEN_ENV = 'CLAUDESWITCHER_TOKEN'

/**
 * Written by an earlier version, retired since. Only the retired status line script read it; the
 * hook URLs contain the port directly. Removed on both install and uninstall.
 */
const LEGACY_PORT_ENV = 'CLAUDESWITCHER_PORT'

/** A new object without the given keys, instead of `delete`, which would mutate. */
function without(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)))
}

/**
 * True if ONE hook is ours.
 *
 * Primary sign: `allowedEnvVars` refers to our token. It does not depend on the port, so it also
 * recognises an old install after a port change.
 *
 * Fallback sign: it points to our own loopback endpoint, on the `DAEMON_PORT` port. The port is a
 * condition too: another local tool may use the same path on another port, and the install would
 * otherwise silently delete its hook. The fallback is needed because `allowedEnvVars` is not a
 * condition for the hook to run: it only permits the env variable substitution. If someone removes
 * it, the entry would become an unrecognisable orphan: every new install would add another
 * duplicate next to it, and uninstall would never remove it.
 */
function isOurHook(hook: unknown): boolean {
  if (!isRecord(hook)) return false
  const allowed = hook['allowedEnvVars']
  if (Array.isArray(allowed) && allowed.includes(TOKEN_ENV)) return true
  const url = hook['url']
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    // The protocol has to be checked too. `new URL` fills in the host and the path for any scheme,
    // so without this a `file://127.0.0.1/hooks/notification` would count as ours, which is too
    // loose an identification.
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return (
      isHttp &&
      parsed.hostname === DAEMON_HOST &&
      parsed.port === String(DAEMON_PORT) &&
      OUR_HOOK_PATHS.has(parsed.pathname)
    )
  } catch {
    return false
  }
}

/**
 * Removes our own hooks from an event's matcher groups.
 *
 * Works at HOOK level, not group level: if the user added their own command to the `hooks` array
 * of our group, dropping the whole group would take their hook too. A group disappears only if it
 * consisted solely of our hooks.
 */
function stripOurHooks(list: readonly unknown[]): unknown[] {
  return list.flatMap((entry) => {
    if (!isRecord(entry)) return [entry]
    const hooks = entry['hooks']
    if (!Array.isArray(hooks)) return [entry]
    const foreign = hooks.filter((hook) => !isOurHook(hook))
    if (foreign.length === 0) return []
    if (foreign.length === hooks.length) return [entry]
    return [{ ...entry, hooks: foreign }]
  })
}

/** Removes ours from the given events; an event key left empty disappears too. */
function stripEvents(hooks: Record<string, unknown>, events: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...hooks }
  const emptied: string[] = []
  for (const event of events) {
    const current = result[event]
    if (!Array.isArray(current)) continue
    const foreign = stripOurHooks(current)
    if (foreign.length === 0) emptied.push(event)
    else result[event] = foreign
  }
  return without(result, emptied)
}

/**
 * The marker at the end of our retired status line command. An earlier version installed the status
 * line (the VSCode extension does not run it); today it is only needed to recognise the old entry:
 * it is removed on both install and uninstall.
 *
 * The path alone does not identify it: the `packages/statusline/dist/main.js` layout is not ours
 * but common, and the same kind of status line from another repo would be taken for ours and then
 * deleted. So a status line without the marker is never ours.
 */
const STATUS_LINE_MARKER = '--claudeswitcher'

/** True if the status line is our own retired entry: by our marker, not by its path. */
function isOurStatusLine(statusLine: unknown): boolean {
  if (!isRecord(statusLine)) return false
  const command = statusLine['command']
  return typeof command === 'string' && command.includes(STATUS_LINE_MARKER)
}

/** The hook's URL. Both the install and the staleness check take it from here. */
function hookUrl(port: number, { route }: HookContractEntry): string {
  return `http://${DAEMON_HOST}:${String(port)}${hookPath(route)}`
}

function ourHookEntry(port: number, hook: HookContractEntry): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'http',
        url: hookUrl(port, hook),
        timeout: hook.timeoutSeconds,
        headers: { Authorization: `Bearer $${TOKEN_ENV}` },
        allowedEnvVars: [TOKEN_ENV],
      },
    ],
  }
}

/**
 * A new object without our retired status line, if it is still ours. It does not touch a foreign
 * one. Always returns a copy: the callers keep writing to the returned object.
 */
function withoutOurStatusLine(settings: Record<string, unknown>): Record<string, unknown> {
  return isOurStatusLine(settings['statusLine']) ? without(settings, ['statusLine']) : { ...settings }
}

/**
 * The pure transformation of the install.
 *
 * It deletes and overwrites nothing that is not ours: foreign hooks stay in their event's array,
 * and a foreign or malformed value is reported as a conflict. The retired entries of the earlier
 * version (the `SessionStart` hook, the status line, the port env variable) are removed, so a
 * reinstall migrates as well.
 */
export function applyIntegration(
  existing: Record<string, unknown>,
  options: IntegrationOptions,
): IntegrationResult {
  const settings: Record<string, unknown> = withoutOurStatusLine(existing)
  const conflicts: string[] = []

  const rawHooks = existing['hooks']
  if (rawHooks !== undefined && !isRecord(rawHooks)) {
    conflicts.push('A "hooks" érték nem objektum, ezért a hookokat nem telepítettük.')
  } else {
    const hooks: Record<string, unknown> = isRecord(rawHooks) ? { ...rawHooks } : {}
    for (const hook of HOOK_CONTRACT) {
      const current = hooks[hook.event]
      if (current !== undefined && !Array.isArray(current)) {
        conflicts.push(`A "hooks.${hook.event}" érték nem tömb, ezért ezt az eseményt kihagytuk.`)
        continue
      }
      const foreign = stripOurHooks(Array.isArray(current) ? current : [])
      hooks[hook.event] = [...foreign, ourHookEntry(options.port, hook)]
    }
    settings['hooks'] = stripEvents(hooks, LEGACY_EVENTS)
  }

  const rawEnv = existing['env']
  if (rawEnv !== undefined && !isRecord(rawEnv)) {
    conflicts.push('Az "env" érték nem objektum, ezért a tokent nem állítottuk be.')
  } else {
    settings['env'] = {
      ...without(isRecord(rawEnv) ? rawEnv : {}, [LEGACY_PORT_ENV]),
      [TOKEN_ENV]: options.token,
    }
  }

  return { settings, conflicts }
}

/**
 * The pure transformation of the uninstall: it removes only our own entries (the earlier version's
 * retired entries too) and deletes a `hooks` / `env` key left empty, so an uninstall after an
 * install gives back exactly the original settings.
 */
export function removeIntegration(existing: Record<string, unknown>): Record<string, unknown> {
  let settings: Record<string, unknown> = withoutOurStatusLine(existing)

  const rawHooks = existing['hooks']
  if (isRecord(rawHooks)) {
    const hooks = stripEvents(rawHooks, [...HOOK_CONTRACT.map((hook) => hook.event), ...LEGACY_EVENTS])
    settings = Object.keys(hooks).length === 0 ? without(settings, ['hooks']) : { ...settings, hooks }
  }

  const rawEnv = existing['env']
  if (isRecord(rawEnv)) {
    const env = without(rawEnv, [LEGACY_PORT_ENV, TOKEN_ENV])
    settings = Object.keys(env).length === 0 ? without(settings, ['env']) : { ...settings, env }
  }

  return settings
}

/**
 * The state of our installed hooks according to settings.json.
 *
 * - `not-installed`: no `HOOK_CONTRACT` event has a hook of ours.
 * - `current`: every event has a hook of ours on the right route and on `DAEMON_PORT`.
 * - `stale`: ours are there, but for the `missing` events the hook is absent or points to a wrong
 *   route or port. An install by an earlier version looks like this once a new event has been added
 *   to `HOOK_CONTRACT`.
 * - `unknown`: the file cannot be read or parsed. That is not "stale": we do not know.
 *
 * The kinds are listed once, in `INTEGRATION_KINDS` (the setup window checks against it).
 */
export type HookInstallState =
  | { kind: Exclude<IntegrationKind, 'stale'> }
  | { kind: 'stale'; missing: string[] }

/** Our hooks of one event, across the matcher groups. A malformed entry holds none of ours. */
function ourHooksOf(groups: unknown): Record<string, unknown>[] {
  if (!Array.isArray(groups)) return []
  return groups.flatMap((group) => {
    if (!isRecord(group)) return []
    const hooks = group['hooks']
    if (!Array.isArray(hooks)) return []
    return hooks.filter((hook): hook is Record<string, unknown> => isRecord(hook) && isOurHook(hook))
  })
}

/**
 * A pure function: from the `hooks` section of settings.json it tells which of our events are
 * missing. The expected URL comes from the same `HOOK_CONTRACT` and `hookUrl` the install writes
 * from.
 */
export function hookInstallState(hooks: unknown, port: number = DAEMON_PORT): HookInstallState {
  if (!isRecord(hooks)) return { kind: 'not-installed' }
  let anyOurs = false
  const missing: string[] = []
  for (const entry of HOOK_CONTRACT) {
    const ours = ourHooksOf(hooks[entry.event])
    if (ours.length > 0) anyOurs = true
    const expected = hookUrl(port, entry)
    if (!ours.some((hook) => hook['url'] === expected)) missing.push(entry.event)
  }
  if (!anyOurs) return { kind: 'not-installed' }
  return missing.length === 0 ? { kind: 'current' } : { kind: 'stale', missing }
}

/** The one line shown in the tray, or `undefined` if there is nothing to say. */
export function integrationNotice(state: HookInstallState): string | undefined {
  if (state.kind !== 'stale') return undefined
  return `Integráció elavult, telepítsd újra (${String(state.missing.length)} hiányzó hook)`
}

/**
 * Only reads: it looks for settings.json where the install writes it (`userSettingsPath`), but never
 * writes it. A missing file: not installed. Every other read or parse error is `unknown`.
 */
export async function readHookInstallState(claudeDir: string): Promise<HookInstallState> {
  let raw: string
  try {
    raw = await readFile(userSettingsPath(claudeDir), 'utf8')
  } catch (error) {
    return isNotFoundError(error) ? { kind: 'not-installed' } : { kind: 'unknown' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unknown' }
  }
  return isRecord(parsed) ? hookInstallState(parsed['hooks']) : { kind: 'unknown' }
}

/** Installs into the user's settings.json. Returns the descriptions of the conflicts. */
export async function installIntegration(
  claudeDir: string,
  options: IntegrationOptions,
): Promise<string[]> {
  let conflicts: string[] = []
  await transformSettingsFile(userSettingsPath(claudeDir), (existing) => {
    const result = applyIntegration(existing, options)
    conflicts = result.conflicts
    return result.settings
  })
  return conflicts
}

/** Removes our own entries from the user's settings.json. */
export function uninstallIntegration(claudeDir: string): Promise<void> {
  return transformSettingsFile(userSettingsPath(claudeDir), removeIntegration)
}
