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

const HOOK_ROUTES: Readonly<Record<string, string>> = {
  Notification: 'notification',
  SessionStart: 'lifecycle/start',
  SessionEnd: 'lifecycle/end',
  Stop: 'lifecycle/stop',
}

const TOKEN_ENV = 'CLAUDESWITCHER_TOKEN'
const PORT_ENV = 'CLAUDESWITCHER_PORT'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A saját hook-végpontjaink útvonalai. */
const OUR_HOOK_PATHS = /^\/hooks\/(notification|lifecycle\/(start|end|stop))$/

/**
 * Igaz, ha EGY hook a mienk.
 *
 * Elsődleges jel: az `allowedEnvVars` hivatkozik a tokenünkre. Portfüggetlen, tehát egy
 * portváltás után is felismeri a régi telepítést.
 *
 * Tartalék jel: a saját loopback-végpontunkra mutat. Azért kell, mert az `allowedEnvVars`
 * nem feltétele annak, hogy a hook lefusson — csak az env-változó behelyettesítését
 * engedélyezi. Ha valaki kiveszi, a bejegyzés felismerhetetlen árvává válna: minden újabb
 * telepítés egy újabb duplikátumot tenne mellé, az eltávolítás pedig soha nem vinné el.
 */
export function isOurHook(hook: unknown): boolean {
  if (!isPlainObject(hook)) return false
  if (Array.isArray(hook.allowedEnvVars) && hook.allowedEnvVars.includes(TOKEN_ENV)) return true
  if (typeof hook.url !== 'string') return false
  try {
    const url = new URL(hook.url)
    return url.hostname === '127.0.0.1' && OUR_HOOK_PATHS.test(url.pathname)
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
function stripOurHooks(list: unknown[]): unknown[] {
  return list.flatMap((entry) => {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return [entry]
    const foreign = entry.hooks.filter((hook) => !isOurHook(hook))
    if (foreign.length === 0) return []
    if (foreign.length === entry.hooks.length) return [entry]
    return [{ ...entry, hooks: foreign }]
  })
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
  return (
    isPlainObject(statusLine) &&
    typeof statusLine.command === 'string' &&
    statusLine.command.includes(STATUS_LINE_MARKER)
  )
}

function ourHookEntry(port: number, route: string): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/hooks/${route}`,
        // Rövid timeout: display-only hookok, nem tudnak és nem is akarnak blokkolni.
        timeout: 5,
        headers: { Authorization: `Bearer $${TOKEN_ENV}` },
        allowedEnvVars: [TOKEN_ENV],
      },
    ],
  }
}

/**
 * A telepítés tiszta transzformációja. Az M1 kizárólag nem blokkoló hookokat telepít — a
 * PermissionRequest az M2 hatásköre, addig egyetlen döntést sem veszünk el.
 *
 * Semmit nem töröl és nem ír felül, ami nem a mienk: az idegen hookok megmaradnak az
 * eseményük tömbjében, egy idegen vagy hibás alakú érték pedig ütközésként jelentődik.
 */
export function applyIntegration(
  existing: Record<string, unknown>,
  options: IntegrationOptions,
): IntegrationResult {
  const settings: Record<string, unknown> = { ...existing }
  const conflicts: string[] = []

  const rawHooks = existing.hooks
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
    settings.hooks = hooks
  }

  const previousStatusLine = existing.statusLine
  if (previousStatusLine === undefined || isOurStatusLine(previousStatusLine)) {
    const previousPadding = isPlainObject(previousStatusLine) ? previousStatusLine.padding : undefined
    settings.statusLine = {
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

  const rawEnv = existing.env
  if (rawEnv !== undefined && !isPlainObject(rawEnv)) {
    conflicts.push('Az "env" érték nem objektum, ezért a portot és a tokent nem állítottuk be.')
  } else {
    settings.env = {
      ...(isPlainObject(rawEnv) ? rawEnv : {}),
      [PORT_ENV]: String(options.port),
      [TOKEN_ENV]: options.token,
    }
  }

  return { settings, conflicts }
}

/**
 * Az eltávolítás tiszta transzformációja: csak a saját bejegyzéseinket veszi ki, és a
 * kiürült `hooks` / `env` kulcsot is törli, így egy telepítés utáni eltávolítás pontosan az
 * eredeti beállításokat adja vissza.
 */
export function removeIntegration(existing: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...existing }

  const rawHooks = existing.hooks
  if (isPlainObject(rawHooks)) {
    const hooks: Record<string, unknown> = { ...rawHooks }
    for (const event of Object.keys(HOOK_ROUTES)) {
      const current = hooks[event]
      if (!Array.isArray(current)) continue
      const foreign = stripOurHooks(current)
      if (foreign.length === 0) delete hooks[event]
      else hooks[event] = foreign
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks
    else settings.hooks = hooks
  }

  if (isOurStatusLine(existing.statusLine)) delete settings.statusLine

  const rawEnv = existing.env
  if (isPlainObject(rawEnv)) {
    const env: Record<string, unknown> = { ...rawEnv }
    delete env[PORT_ENV]
    delete env[TOKEN_ENV]
    if (Object.keys(env).length === 0) delete settings.env
    else settings.env = env
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
