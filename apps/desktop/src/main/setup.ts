import { readFile } from 'node:fs/promises'
import { isNotFoundError, transformSettingsFile, userSettingsPath } from '@claudeswitcher/core'
import { DAEMON_PORT } from './daemon-port.js'

export { DAEMON_PORT } from './daemon-port.js'

export interface IntegrationOptions {
  port: number
  token: string
  statusLineCommand: string
}

export interface IntegrationResult {
  settings: Record<string, unknown>
  /** Emberi olvasásra szánt leírások arról, amit szándékosan nem írtunk felül. */
  conflicts: string[]
}

interface HookRoute {
  route: string
  /** Másodperc. */
  timeout: number
}

/**
 * A telepített hookok.
 *
 * A `PermissionRequest` az egyetlen, ami döntést tart: 600 mp-es timeoutját a DecisionBroker
 * 590 mp-nél előzi meg, hogy a lezárást mindig mi kezdeményezzük. A többi display-only, rövid
 * timeouttal. A `PreToolUse` / `PostToolUse` / `SubagentStop` azért kell, mert a VSCode-ban vagy
 * a telefonon hozott döntést csak ezekből lehet felismerni (spec §7).
 *
 * A két hibás végű esemény a sikeres párja route-ját kapja, mert ennek az appnak ugyanazt jelenti.
 * A `PostToolUseFailure` egy elindult, de hibával zárult tool: a döntés megvolt, a sor zárul. A
 * route csak a `session_id`-t és a `tool_use_id`-t olvassa, és a hookdokumentáció szerint mindkettő
 * benne van. A `StopFailure` a Stop helyett jön, ha a kör API-hibával ért véget (rate limit,
 * overloaded): a fő kör ugyanúgy véget ért. A válaszát a Claude Code a `terminalSequence`
 * kivételével figyelmen kívül hagyja, így az üres 200 elég. Mindkettő illeszkedik az
 * `OUR_HOOK_PATHS`-ra, tehát a telepítés és az eltávolítás külön kód nélkül kezeli őket.
 */
const HOOK_ROUTES: Readonly<Record<string, HookRoute>> = {
  Notification: { route: 'notification', timeout: 5 },
  SessionEnd: { route: 'lifecycle/end', timeout: 5 },
  Stop: { route: 'lifecycle/stop', timeout: 5 },
  StopFailure: { route: 'lifecycle/stop', timeout: 5 },
  PermissionRequest: { route: 'permission-request', timeout: 600 },
  PreToolUse: { route: 'pre-tool-use', timeout: 5 },
  PostToolUse: { route: 'post-tool-use', timeout: 5 },
  PostToolUseFailure: { route: 'post-tool-use', timeout: 5 },
  SubagentStop: { route: 'subagent-stop', timeout: 5 },
}

/**
 * Egy korábbi verzió telepítette, azóta kivezetve. A `SessionStart` HTTP-hookként soha nem
 * tüzel (mérve, M2 spike). Telepítéskor és eltávolításkor is kivesszük a mi bejegyzésünket.
 */
const LEGACY_EVENTS: readonly string[] = ['SessionStart']

const TOKEN_ENV = 'CLAUDESWITCHER_TOKEN'
const PORT_ENV = 'CLAUDESWITCHER_PORT'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Új objektum a megadott kulcsok nélkül — `delete` helyett, ami mutálna. */
function without(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)))
}

/** A saját hook-végpontjaink útvonalai, a kivezetett `lifecycle/start`-tal együtt. */
const OUR_HOOK_PATHS =
  /^\/hooks\/(notification|permission-request|pre-tool-use|post-tool-use|subagent-stop|lifecycle\/(start|end|stop))$/

/**
 * Igaz, ha EGY hook a mienk.
 *
 * Elsődleges jel: az `allowedEnvVars` hivatkozik a tokenünkre. Portfüggetlen, tehát egy
 * portváltás után is felismeri a régi telepítést.
 *
 * Tartalék jel: a saját loopback-végpontunkra mutat, a `DAEMON_PORT` porton. A port is
 * feltétel: egy másik helyi eszköz ugyanilyen útvonalat használhat egy másik porton, és annak
 * a hookját a telepítés különben némán törölné. Azért kell, mert az `allowedEnvVars`
 * nem feltétele annak, hogy a hook lefusson — csak az env-változó behelyettesítését
 * engedélyezi. Ha valaki kiveszi, a bejegyzés felismerhetetlen árvává válna: minden újabb
 * telepítés egy újabb duplikátumot tenne mellé, az eltávolítás pedig soha nem vinné el.
 */
export function isOurHook(hook: unknown): boolean {
  if (!isPlainObject(hook)) return false
  const allowed = hook['allowedEnvVars']
  if (Array.isArray(allowed) && allowed.includes(TOKEN_ENV)) return true
  const url = hook['url']
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    // A protokollt is nézni kell. A `new URL` a hostot és az útvonalat bármilyen sémára
    // kitölti, így e nélkül egy `file://127.0.0.1/hooks/notification` is a mienknek
    // számítana — túl tág azonosítás.
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return (
      isHttp &&
      parsed.hostname === '127.0.0.1' &&
      parsed.port === String(DAEMON_PORT) &&
      OUR_HOOK_PATHS.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

/**
 * Kiveszi a saját hookjainkat egy esemény matcher-csoportjaiból.
 *
 * HOOK-szinten dolgozik, nem csoportszinten: ha a felhasználó a saját parancsát a mi
 * csoportunk `hooks` tömbjébe fűzte be, a csoport egészének eldobása az ő hookját is
 * elvinné. Egy csoport csak akkor tűnik el, ha kizárólag a mi hookjainkból állt.
 */
function stripOurHooks(list: readonly unknown[]): unknown[] {
  return list.flatMap((entry) => {
    if (!isPlainObject(entry)) return [entry]
    const hooks = entry['hooks']
    if (!Array.isArray(hooks)) return [entry]
    const foreign = hooks.filter((hook) => !isOurHook(hook))
    if (foreign.length === 0) return []
    if (foreign.length === hooks.length) return [entry]
    return [{ ...entry, hooks: foreign }]
  })
}

/** A megadott eseményekből kiveszi a mieinket; a kiürült eseménykulcs is eltűnik. */
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
 * Jelölő a status line parancsunk végén.
 *
 * Azért kell, mert az útvonal önmagában nem azonosít: a `packages/statusline/dist/main.js`
 * elrendezés nem a miénk, hanem elterjedt, és egy másik repó ugyanilyen status line-ját a
 * sajátunknak néznénk — ütközésjelzés nélkül felülírnánk, majd az eltávolításnál törölnénk.
 * A statusline scriptünk az argumentumait nem olvassa (a bemenete stdin), így a jelölő
 * ártalmatlan, viszont egyértelmű.
 */
export const STATUS_LINE_MARKER = '--claudeswitcher'

/** Igaz, ha a status line a mienk — a jelölőnk alapján, nem az útvonala alapján. */
export function isOurStatusLine(statusLine: unknown): boolean {
  if (!isPlainObject(statusLine)) return false
  const command = statusLine['command']
  return typeof command === 'string' && command.includes(STATUS_LINE_MARKER)
}

/** A hook URL-je. A telepítés és az elavultság-ellenőrzés is innen veszi. */
function hookUrl(port: number, { route }: HookRoute): string {
  return `http://127.0.0.1:${String(port)}/hooks/${route}`
}

function ourHookEntry(port: number, hookRoute: HookRoute): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'http',
        url: hookUrl(port, hookRoute),
        timeout: hookRoute.timeout,
        headers: { Authorization: `Bearer $${TOKEN_ENV}` },
        allowedEnvVars: [TOKEN_ENV],
      },
    ],
  }
}

/**
 * A telepítés tiszta transzformációja.
 *
 * Semmit nem töröl és nem ír felül, ami nem a mienk: az idegen hookok megmaradnak az
 * eseményük tömbjében, egy idegen vagy hibás alakú érték pedig ütközésként jelentődik. A
 * korábbi verzió kivezetett eseményeiből a saját bejegyzésünket kivesszük.
 */
export function applyIntegration(
  existing: Record<string, unknown>,
  options: IntegrationOptions,
): IntegrationResult {
  const settings: Record<string, unknown> = { ...existing }
  const conflicts: string[] = []

  const rawHooks = existing['hooks']
  if (rawHooks !== undefined && !isPlainObject(rawHooks)) {
    conflicts.push('A "hooks" érték nem objektum, ezért a hookokat nem telepítettük.')
  } else {
    const hooks: Record<string, unknown> = isPlainObject(rawHooks) ? { ...rawHooks } : {}
    for (const [event, route] of Object.entries(HOOK_ROUTES)) {
      const current = hooks[event]
      if (current !== undefined && !Array.isArray(current)) {
        conflicts.push(`A "hooks.${event}" érték nem tömb, ezért ezt az eseményt kihagytuk.`)
        continue
      }
      const foreign = stripOurHooks(Array.isArray(current) ? current : [])
      hooks[event] = [...foreign, ourHookEntry(options.port, route)]
    }
    settings['hooks'] = stripEvents(hooks, LEGACY_EVENTS)
  }

  const previousStatusLine = existing['statusLine']
  if (previousStatusLine === undefined || isOurStatusLine(previousStatusLine)) {
    const previousPadding = isPlainObject(previousStatusLine) ? previousStatusLine['padding'] : undefined
    settings['statusLine'] = {
      type: 'command',
      command: `${options.statusLineCommand} ${STATUS_LINE_MARKER}`,
      // A felhasználó által állított padding megmarad; enélkül minden újratelepítés
      // visszaállítaná nullára.
      padding: typeof previousPadding === 'number' ? previousPadding : 0,
    }
  } else {
    conflicts.push(
      'Már van saját status line beállítva, ezt nem írtuk felül — a limitek így nem jelennek meg.',
    )
  }

  const rawEnv = existing['env']
  if (rawEnv !== undefined && !isPlainObject(rawEnv)) {
    conflicts.push('Az "env" érték nem objektum, ezért a portot és a tokent nem állítottuk be.')
  } else {
    settings['env'] = {
      ...(isPlainObject(rawEnv) ? rawEnv : {}),
      [PORT_ENV]: String(options.port),
      [TOKEN_ENV]: options.token,
    }
  }

  return { settings, conflicts }
}

/**
 * Az eltávolítás tiszta transzformációja: csak a saját bejegyzéseinket veszi ki (a kivezetett
 * eseményekből is), és a kiürült `hooks` / `env` kulcsot is törli, így egy telepítés utáni
 * eltávolítás pontosan az eredeti beállításokat adja vissza.
 */
export function removeIntegration(existing: Record<string, unknown>): Record<string, unknown> {
  let settings: Record<string, unknown> = { ...existing }

  const rawHooks = existing['hooks']
  if (isPlainObject(rawHooks)) {
    const hooks = stripEvents(rawHooks, [...Object.keys(HOOK_ROUTES), ...LEGACY_EVENTS])
    settings = Object.keys(hooks).length === 0 ? without(settings, ['hooks']) : { ...settings, hooks }
  }

  if (isOurStatusLine(existing['statusLine'])) settings = without(settings, ['statusLine'])

  const rawEnv = existing['env']
  if (isPlainObject(rawEnv)) {
    const env = without(rawEnv, [PORT_ENV, TOKEN_ENV])
    settings = Object.keys(env).length === 0 ? without(settings, ['env']) : { ...settings, env }
  }

  return settings
}

/**
 * A telepített hookjaink állapota a settings.json szerint.
 *
 * - `not-installed`: egyik `HOOK_ROUTES` eseménynél sincs saját hookunk.
 * - `current`: minden eseménynél van saját hookunk a helyes route-ra és a `DAEMON_PORT`-ra.
 * - `stale`: a mieink ott vannak, de a `missing` eseményeknél hiányzik a hook, vagy rossz route-ra
 *   vagy portra mutat. Egy korábbi verzió telepítése ilyen, ha azóta új esemény került a
 *   `HOOK_ROUTES`-ba.
 * - `unknown`: a fájl nem olvasható vagy nem értelmezhető. Ez nem „elavult": nem tudjuk.
 */
export type HookInstallState =
  | { kind: 'not-installed' }
  | { kind: 'current' }
  | { kind: 'stale'; missing: string[] }
  | { kind: 'unknown' }

/** Egy esemény saját hookjai, a matcher-csoportokon át. Hibás alakú bejegyzés: nincs benne a mienk. */
function ourHooksOf(groups: unknown): Record<string, unknown>[] {
  if (!Array.isArray(groups)) return []
  return groups.flatMap((group) => {
    if (!isPlainObject(group)) return []
    const hooks = group['hooks']
    if (!Array.isArray(hooks)) return []
    return hooks.filter((hook): hook is Record<string, unknown> => isPlainObject(hook) && isOurHook(hook))
  })
}

/**
 * Tiszta függvény: a settings.json `hooks` szakaszából megmondja, mely eseményeink hiányoznak.
 * Az elvárt URL ugyanabból a `HOOK_ROUTES`-ból és `hookUrl`-ből jön, amiből a telepítés is ír.
 */
export function hookInstallState(hooks: unknown, port: number = DAEMON_PORT): HookInstallState {
  if (!isPlainObject(hooks)) return { kind: 'not-installed' }
  let anyOurs = false
  const missing: string[] = []
  for (const [event, route] of Object.entries(HOOK_ROUTES)) {
    const ours = ourHooksOf(hooks[event])
    if (ours.length > 0) anyOurs = true
    const expected = hookUrl(port, route)
    if (!ours.some((hook) => hook['url'] === expected)) missing.push(event)
  }
  if (!anyOurs) return { kind: 'not-installed' }
  return missing.length === 0 ? { kind: 'current' } : { kind: 'stale', missing }
}

/** A tálcán mutatott egy sor, vagy `undefined`, ha nincs mit mondani. */
export function integrationNotice(state: HookInstallState): string | undefined {
  if (state.kind !== 'stale') return undefined
  return `Integráció elavult, telepítsd újra (${String(state.missing.length)} hiányzó hook)`
}

/**
 * Csak olvas: a settings.json-t ugyanott keresi, ahová a telepítés ír (`userSettingsPath`), de soha
 * nem írja. Hiányzó fájl: nincs telepítve. Minden más olvasási vagy értelmezési hiba `unknown`.
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
  return isPlainObject(parsed) ? hookInstallState(parsed['hooks']) : { kind: 'unknown' }
}

/** Telepít a felhasználó settings.json-jába. Az ütközések leírását adja vissza. */
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

/** Eltávolítja a saját bejegyzéseinket a felhasználó settings.json-jából. */
export function uninstallIntegration(claudeDir: string): Promise<void> {
  return transformSettingsFile(userSettingsPath(claudeDir), removeIntegration)
}
