import { transformSettingsFile, userSettingsPath } from '@claudeswitcher/core'

/**
 * A daemon rögzített portja. Nem ideiglenes, mert a telepített hookok és a statusLine ezt
 * az URL-t kapják a settings.json-ban: egy újraindításonként változó port minden
 * újraindítás után halottá tenné őket.
 */
export const DAEMON_PORT = 47821

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
 */
const HOOK_ROUTES: Readonly<Record<string, HookRoute>> = {
  Notification: { route: 'notification', timeout: 5 },
  SessionEnd: { route: 'lifecycle/end', timeout: 5 },
  Stop: { route: 'lifecycle/stop', timeout: 5 },
  PermissionRequest: { route: 'permission-request', timeout: 600 },
  PreToolUse: { route: 'pre-tool-use', timeout: 5 },
  PostToolUse: { route: 'post-tool-use', timeout: 5 },
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

function ourHookEntry(port: number, { route, timeout }: HookRoute): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/hooks/${route}`,
        timeout,
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
