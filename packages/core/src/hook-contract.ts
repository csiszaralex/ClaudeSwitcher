/**
 * A Claude Code hookjai és a daemon végpontjai közötti szerződés, egy helyen.
 *
 * Innen veszi a desktop telepítője a settings.json bejegyzéseit és a „mienk-e" felismerést, a daemon
 * a route-jai útvonalát, a renderer pedig az elengedés idejét a tooltiphez. IO-mentes, a
 * `/browser` belépési pont is exportálja.
 */

/** Minden hook-végpontunk ez alatt az előtag alatt él. */
const HOOK_PATH_PREFIX = '/hooks/'

/**
 * A `PermissionRequest` hook timeoutja másodpercben. Ez az egyetlen hook, ami döntést tart: a
 * DecisionBroker `PERMISSION_RELEASE_AFTER_MS` után elengedi a kérést, hogy a lezárást mindig mi
 * kezdeményezzük, ne a Claude Code timeoutja.
 */
export const PERMISSION_REQUEST_TIMEOUT_S = 600

/**
 * Ennyivel a hook timeoutja előtt engedi el a broker a tartott kérést, üres 200-zal. A natív prompt
 * ettől nem tűnik el, és utána is válaszolható (mérve: 2,5 perccel az elengedés után is).
 */
export const PERMISSION_RELEASE_MARGIN_MS = 10_000

/** A tartott PermissionRequest elengedésének ideje: a hook timeoutja mínusz a tartalék. */
export const PERMISSION_RELEASE_AFTER_MS = PERMISSION_REQUEST_TIMEOUT_S * 1000 - PERMISSION_RELEASE_MARGIN_MS

/**
 * A telepített hookok: esemény, route (a `/hooks/` utáni rész) és timeout másodpercben.
 *
 * A `PermissionRequest` kivételével mind display-only, rövid timeouttal. A `PreToolUse` /
 * `PostToolUse` / `SubagentStop` azért kell, mert a VSCode-ban vagy a telefonon hozott döntést csak
 * ezekből lehet felismerni (spec §7).
 *
 * A két hibás végű esemény a sikeres párja route-ját kapja, mert ennek az appnak ugyanazt jelenti.
 * A `PostToolUseFailure` egy elindult, de hibával zárult tool: a döntés megvolt, a sor zárul. A
 * route csak a `session_id`-t és a `tool_use_id`-t olvassa, és a hookdokumentáció szerint mindkettő
 * benne van. A `StopFailure` a Stop helyett jön, ha a kör API-hibával ért véget (rate limit,
 * overloaded): a fő kör ugyanúgy véget ért. A válaszát a Claude Code a `terminalSequence`
 * kivételével figyelmen kívül hagyja, így az üres 200 elég.
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

/** Egy telepített hook a szerződésből. */
export type HookContractEntry = (typeof HOOK_CONTRACT)[number]

/**
 * Egy telepített hook route-ja. A daemon a fix route-jai útvonalát a `hookPath`-tal írja, így ott egy
 * elírás fordítási hiba. A paraméteres `lifecycle/:kind` route-ot a daemon tesztje fedi.
 */
export type HookRoute = HookContractEntry['route']

/**
 * Egy korábbi verzió telepítette, azóta kivezetve. A `SessionStart` HTTP-hookként soha nem tüzel
 * (mérve, M2 spike). Csak azért van itt, hogy a telepítés és az eltávolítás felismerje és kivegye
 * a régi bejegyzést.
 */
export const LEGACY_HOOK_CONTRACT = [{ event: 'SessionStart', route: 'lifecycle/start' }] as const

/** Egy kivezetett hook route-ja. */
export type LegacyHookRoute = (typeof LEGACY_HOOK_CONTRACT)[number]['route']

/** Egy route URL-útvonala, például `/hooks/permission-request`. */
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

/** A saját hook-végpontjaink útvonalai, a kivezetettekkel együtt: ezekről ismerjük fel a mieinket. */
export const OUR_HOOK_PATHS: ReadonlySet<string> = new Set(
  [...HOOK_CONTRACT, ...LEGACY_HOOK_CONTRACT].map((hook) => hookPath(hook.route)),
)
