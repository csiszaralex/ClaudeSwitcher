import { readFile } from 'node:fs/promises'
import {
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
import { DAEMON_PORT } from './daemon-port.js'

export { DAEMON_PORT } from './daemon-port.js'

export interface IntegrationOptions {
  port: number
  token: string
}

export interface IntegrationResult {
  settings: Record<string, unknown>
  /** Emberi olvasásra szánt leírások arról, amit szándékosan nem írtunk felül. */
  conflicts: string[]
}

/**
 * A telepített hookok és a kivezetettek a core szerződéséből (`HOOK_CONTRACT`,
 * `LEGACY_HOOK_CONTRACT`). A hibás végű események (`PostToolUseFailure`, `StopFailure`) a sikeres
 * párjuk route-ját kapják, ezért az `OUR_HOOK_PATHS`-ra illeszkednek, és a telepítés meg az
 * eltávolítás külön kód nélkül kezeli őket.
 */
const LEGACY_EVENTS: readonly string[] = LEGACY_HOOK_CONTRACT.map((hook) => hook.event)

const TOKEN_ENV = 'CLAUDESWITCHER_TOKEN'

/**
 * Egy korábbi verzió írta, azóta kivezetve. Csak a kivezetett status line scriptje olvasta, a
 * hookok URL-je a portot közvetlenül tartalmazza. Telepítéskor és eltávolításkor is kivesszük.
 */
const LEGACY_PORT_ENV = 'CLAUDESWITCHER_PORT'

/** Új objektum a megadott kulcsok nélkül, `delete` helyett, ami mutálna. */
function without(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)))
}

/**
 * Igaz, ha EGY hook a mienk.
 *
 * Elsődleges jel: az `allowedEnvVars` hivatkozik a tokenünkre. Portfüggetlen, tehát egy
 * portváltás után is felismeri a régi telepítést.
 *
 * Tartalék jel: a saját loopback-végpontunkra mutat, a `DAEMON_PORT` porton. A port is
 * feltétel: egy másik helyi eszköz ugyanilyen útvonalat használhat egy másik porton, és annak
 * a hookját a telepítés különben némán törölné. Azért kell, mert az `allowedEnvVars`
 * nem feltétele annak, hogy a hook lefusson: csak az env-változó behelyettesítését
 * engedélyezi. Ha valaki kiveszi, a bejegyzés felismerhetetlen árvává válna: minden újabb
 * telepítés egy újabb duplikátumot tenne mellé, az eltávolítás pedig soha nem vinné el.
 */
function isOurHook(hook: unknown): boolean {
  if (!isRecord(hook)) return false
  const allowed = hook['allowedEnvVars']
  if (Array.isArray(allowed) && allowed.includes(TOKEN_ENV)) return true
  const url = hook['url']
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    // A protokollt is nézni kell. A `new URL` a hostot és az útvonalat bármilyen sémára
    // kitölti, így e nélkül egy `file://127.0.0.1/hooks/notification` is a mienknek
    // számítana, ez túl tág azonosítás.
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return (
      isHttp &&
      parsed.hostname === '127.0.0.1' &&
      parsed.port === String(DAEMON_PORT) &&
      OUR_HOOK_PATHS.has(parsed.pathname)
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
    if (!isRecord(entry)) return [entry]
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
 * Jelölő a kivezetett status line parancsunk végén. Egy korábbi verzió telepítette a status
 * line-t (a VSCode-bővítmény nem futtatja), ma már csak a régi bejegyzés felismerésére kell:
 * telepítéskor és eltávolításkor is kivesszük.
 *
 * Az útvonal önmagában nem azonosít: a `packages/statusline/dist/main.js` elrendezés nem a
 * miénk, hanem elterjedt, és egy másik repó ugyanilyen status line-ját a sajátunknak néznénk,
 * majd törölnénk. A jelölő nélküli status line ezért soha nem a miénk.
 */
const STATUS_LINE_MARKER = '--claudeswitcher'

/** Igaz, ha a status line a kivezetett saját bejegyzésünk: a jelölőnk alapján, nem az útvonala alapján. */
function isOurStatusLine(statusLine: unknown): boolean {
  if (!isRecord(statusLine)) return false
  const command = statusLine['command']
  return typeof command === 'string' && command.includes(STATUS_LINE_MARKER)
}

/** A hook URL-je. A telepítés és az elavultság-ellenőrzés is innen veszi. */
function hookUrl(port: number, { route }: HookContractEntry): string {
  return `http://127.0.0.1:${String(port)}${hookPath(route)}`
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
 * Új objektum a kivezetett status line-unk nélkül, ha az még a miénk. Egy idegenhez nem nyúl.
 * Mindig másolatot ad: a hívók a visszakapott objektumot tovább írják.
 */
function withoutOurStatusLine(settings: Record<string, unknown>): Record<string, unknown> {
  return isOurStatusLine(settings['statusLine']) ? without(settings, ['statusLine']) : { ...settings }
}

/**
 * A telepítés tiszta transzformációja.
 *
 * Semmit nem töröl és nem ír felül, ami nem a mienk: az idegen hookok megmaradnak az
 * eseményük tömbjében, egy idegen vagy hibás alakú érték pedig ütközésként jelentődik. A
 * korábbi verzió kivezetett bejegyzéseit (`SessionStart` hook, status line, port env-változó)
 * kivesszük, így az újratelepítés egyben migrál is.
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
 * Az eltávolítás tiszta transzformációja: csak a saját bejegyzéseinket veszi ki (a korábbi
 * verzió kivezetett bejegyzéseit is), és a kiürült `hooks` / `env` kulcsot is törli, így egy telepítés utáni
 * eltávolítás pontosan az eredeti beállításokat adja vissza.
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
 * A telepített hookjaink állapota a settings.json szerint.
 *
 * - `not-installed`: egyik `HOOK_CONTRACT` eseménynél sincs saját hookunk.
 * - `current`: minden eseménynél van saját hookunk a helyes route-ra és a `DAEMON_PORT`-ra.
 * - `stale`: a mieink ott vannak, de a `missing` eseményeknél hiányzik a hook, vagy rossz route-ra
 *   vagy portra mutat. Egy korábbi verzió telepítése ilyen, ha azóta új esemény került a
 *   `HOOK_CONTRACT`-ba.
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
    if (!isRecord(group)) return []
    const hooks = group['hooks']
    if (!Array.isArray(hooks)) return []
    return hooks.filter((hook): hook is Record<string, unknown> => isRecord(hook) && isOurHook(hook))
  })
}

/**
 * Tiszta függvény: a settings.json `hooks` szakaszából megmondja, mely eseményeink hiányoznak.
 * Az elvárt URL ugyanabból a `HOOK_CONTRACT`-ból és `hookUrl`-ből jön, amiből a telepítés is ír.
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
  return isRecord(parsed) ? hookInstallState(parsed['hooks']) : { kind: 'unknown' }
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
