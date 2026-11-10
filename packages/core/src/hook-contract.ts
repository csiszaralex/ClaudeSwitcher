/**
 * The contract between Claude Code's hooks and the daemon's endpoints, in one place.
 *
 * The desktop installer takes the settings.json entries and the "is this hook ours" test from here,
 * the daemon its route paths, and the renderer the release time for its tooltip. IO-free, also
 * exported by the `/browser` entry point.
 */

/** Every hook endpoint of ours lives under this prefix. */
const HOOK_PATH_PREFIX = '/hooks/'

/**
 * The `PermissionRequest` hook's timeout in seconds. It is the only hook that holds a decision: the
 * DecisionBroker releases the request after `PERMISSION_RELEASE_AFTER_MS`, so the close always
 * comes from us, never from Claude Code's timeout.
 */
export const PERMISSION_REQUEST_TIMEOUT_S = 600

/**
 * How long before the hook's timeout the broker releases a held request, with an empty 200. The
 * native prompt stays, and it can still be answered afterwards (measured: 2.5 minutes after the
 * release).
 */
export const PERMISSION_RELEASE_MARGIN_MS = 10_000

/** When a held PermissionRequest is released: the hook's timeout minus the margin. */
export const PERMISSION_RELEASE_AFTER_MS = PERMISSION_REQUEST_TIMEOUT_S * 1000 - PERMISSION_RELEASE_MARGIN_MS

/**
 * The installed hooks: event, route (the part after `/hooks/`) and timeout in seconds.
 *
 * All but `PermissionRequest` are display-only, with a short timeout. `PreToolUse`, `PostToolUse`
 * and `SubagentStop` are needed because a decision made in VS Code or on the phone can only be
 * recognised from them (design doc, section 7).
 *
 * The two failure events get the route of their success counterpart, because to this app they mean
 * the same. `PostToolUseFailure` is a tool that started but ended in an error: the decision was
 * made, the row closes. That route reads only `session_id` and `tool_use_id`, and the hook
 * documentation says both are present. `StopFailure` comes instead of Stop when the turn ended in
 * an API error (rate limit, overloaded): the main turn ended all the same. Claude Code ignores its
 * response except for `terminalSequence`, so an empty 200 is enough.
 */
export const HOOK_CONTRACT = [
  { event: 'Notification', route: 'notification', timeoutSeconds: 5 },
  { event: 'SessionEnd', route: 'lifecycle/end', timeoutSeconds: 5 },
  { event: 'Stop', route: 'lifecycle/stop', timeoutSeconds: 5 },
  { event: 'StopFailure', route: 'lifecycle/stop', timeoutSeconds: 5 },
  { event: 'PermissionRequest', route: 'permission-request', timeoutSeconds: PERMISSION_REQUEST_TIMEOUT_S },
  { event: 'PreToolUse', route: 'pre-tool-use', timeoutSeconds: 5 },
  { event: 'PostToolUse', route: 'post-tool-use', timeoutSeconds: 5 },
  { event: 'PostToolUseFailure', route: 'post-tool-use', timeoutSeconds: 5 },
  { event: 'SubagentStop', route: 'subagent-stop', timeoutSeconds: 5 },
] as const

/** One installed hook of the contract. */
export type HookContractEntry = (typeof HOOK_CONTRACT)[number]

/**
 * The route of an installed hook. The daemon writes the paths of its fixed routes with `hookPath`,
 * so a typo there is a compile error. The daemon's tests cover the parameterised `lifecycle/:kind`
 * route.
 */
export type HookRoute = HookContractEntry['route']

/**
 * Installed by an earlier version, retired since. `SessionStart` never fires as an HTTP hook
 * (measured in the M2 spike). It is kept only so that install and uninstall recognise and remove
 * the old entry.
 */
export const LEGACY_HOOK_CONTRACT = [{ event: 'SessionStart', route: 'lifecycle/start' }] as const

/** The route of a retired hook. */
export type LegacyHookRoute = (typeof LEGACY_HOOK_CONTRACT)[number]['route']

/** The URL path of a route, for example `/hooks/permission-request`. */
export function hookPath(route: HookRoute | LegacyHookRoute): string {
  return `${HOOK_PATH_PREFIX}${route}`
}

/** The `lifecycle/*` routes share one daemon route, keyed by the part after this segment. */
const LIFECYCLE_SEGMENT = 'lifecycle/'

type LifecycleKindOf<Route> = Route extends `${typeof LIFECYCLE_SEGMENT}${infer Kind}` ? Kind : never

/** A lifecycle kind the daemon handles: the part after `lifecycle/` of a `HOOK_CONTRACT` route. */
export type LifecycleKind = LifecycleKindOf<HookRoute>

const LIFECYCLE_KINDS: ReadonlySet<string> = new Set(
  HOOK_CONTRACT.flatMap(({ route }) =>
    route.startsWith(LIFECYCLE_SEGMENT) ? [route.slice(LIFECYCLE_SEGMENT.length)] : [],
  ),
)

/** True for a lifecycle kind of `HOOK_CONTRACT`. The retired `lifecycle/start` is not one. */
export function isLifecycleKind(kind: string): kind is LifecycleKind {
  return LIFECYCLE_KINDS.has(kind)
}

/**
 * The URL path of a lifecycle route, e.g. `/hooks/lifecycle/stop`. With `:kind` it is the daemon's
 * route pattern; the literal return type is what lets Hono type that parameter as present.
 */
export function lifecyclePath<Kind extends string>(kind: Kind): `${typeof HOOK_PATH_PREFIX}${typeof LIFECYCLE_SEGMENT}${Kind}` {
  return `${HOOK_PATH_PREFIX}${LIFECYCLE_SEGMENT}${kind}`
}

/** The paths of our hook endpoints, retired ones included: this is how we recognise our own hooks. */
export const OUR_HOOK_PATHS: ReadonlySet<string> = new Set(
  [...HOOK_CONTRACT, ...LEGACY_HOOK_CONTRACT].map((hook) => hookPath(hook.route)),
)
