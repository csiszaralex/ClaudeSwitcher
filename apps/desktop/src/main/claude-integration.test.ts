import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tempDir } from '@claudeswitcher/core/testing'
import { describe, expect, it } from 'vitest'
import {
  applyIntegration,
  hookInstallState,
  installIntegration,
  integrationNotice,
  readHookInstallState,
  removeIntegration,
  uninstallIntegration,
} from './claude-integration.js'

function without<T>(source: Record<string, T>, keys: readonly string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)))
}

const OPTIONS = {
  port: 47821,
  token: 'abc123',
}

/** The retired status line as an earlier version installed it: the marker at the end of the command. */
const OUR_OLD_STATUS_LINE = {
  type: 'command',
  command: 'node "P:\\repo\\packages\\statusline\\dist\\main.js" --claudeswitcher',
  padding: 0,
}

/** An install by an earlier version: the hooks, the marked status line and both env variables. */
function olderInstall(base: Record<string, unknown>): Record<string, unknown> {
  const installed = applyIntegration(base, OPTIONS).settings
  const env = installed['env'] as Record<string, unknown>
  return { ...installed, statusLine: OUR_OLD_STATUS_LINE, env: { ...env, CLAUDESWITCHER_PORT: '47821' } }
}

/** The shape of a real user settings.json, measured live. */
const USER_SETTINGS: Record<string, unknown> = {
  permissions: { allow: ['Bash(pnpm build *)', 'Read(//tmp/**)'] },
  model: 'opus[1m]',
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  effortLevel: 'xhigh',
  autoUpdatesChannel: 'latest',
  switchModelsOnFlag: true,
  tui: 'fullscreen',
}

const FOREIGN_NOTIFICATION = {
  hooks: [{ type: 'command', command: 'powershell -c [console]::beep()' }],
}

/** Another repo's status line, with the same common path layout. */
const FOREIGN_STATUS_LINE = {
  type: 'command',
  command: 'node /home/u/otherrepo/packages/statusline/dist/main.js',
  padding: 2,
}

type HookGroups = Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>

describe('applyIntegration', () => {
  it('leaves every existing key of the real settings untouched', () => {
    const { settings } = applyIntegration(USER_SETTINGS, OPTIONS)
    for (const [key, value] of Object.entries(USER_SETTINGS)) {
      expect(settings[key]).toEqual(value)
    }
  })

  it('installs every contract hook event, including the blocking PermissionRequest', () => {
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as Record<string, unknown>
    expect(Object.keys(hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionEnd',
      'Stop',
      'StopFailure',
      'SubagentStop',
    ])
  })

  it('sends a failed tool to the PostToolUse route and an API-error turn end to the Stop route', () => {
    // PostToolUseFailure carries the same session_id and tool_use_id as PostToolUse, and StopFailure
    // marks the end of the main turn just like Stop: no new route is needed.
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as HookGroups
    const failure = hooks['PostToolUseFailure']![0]!.hooks[0]!
    const stopFailure = hooks['StopFailure']![0]!.hooks[0]!
    expect(failure['url']).toBe('http://127.0.0.1:47821/hooks/post-tool-use')
    expect(failure['timeout']).toBe(5)
    expect(stopFailure['url']).toBe('http://127.0.0.1:47821/hooks/lifecycle/stop')
    expect(stopFailure['timeout']).toBe(5)
  })

  it('removes the failure hooks on uninstall, even with allowedEnvVars pruned', () => {
    const ours = (route: string) => ({ hooks: [{ type: 'http', url: `http://127.0.0.1:47821/hooks/${route}` }] })
    const existing = {
      hooks: { PostToolUseFailure: [ours('post-tool-use')], StopFailure: [ours('lifecycle/stop'), FOREIGN_NOTIFICATION] },
    }
    expect(removeIntegration(existing)).toEqual({ hooks: { StopFailure: [FOREIGN_NOTIFICATION] } })
  })

  it('points each hook at the fixed loopback port with the token header', () => {
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as HookGroups
    const hook = hooks['Notification']![0]!.hooks[0]!
    expect(hook['type']).toBe('http')
    expect(hook['url']).toBe('http://127.0.0.1:47821/hooks/notification')
    expect(hook['timeout']).toBe(5)
    expect((hook['headers'] as Record<string, string>)['Authorization']).toBe('Bearer $CLAUDESWITCHER_TOKEN')
    expect(hook['allowedEnvVars']).toEqual(['CLAUDESWITCHER_TOKEN'])
  })

  it('keeps a foreign hook on the same event instead of overwriting it', () => {
    // The original plan replaced the whole array and would have silently deleted this hook.
    const existing = { hooks: { Notification: [FOREIGN_NOTIFICATION] } }
    const hooks = applyIntegration(existing, OPTIONS).settings['hooks'] as Record<string, unknown[]>
    expect(hooks['Notification']).toHaveLength(2)
    expect(hooks['Notification']![0]).toEqual(FOREIGN_NOTIFICATION)
  })

  it('is idempotent: installing twice changes nothing the second time', () => {
    const once = applyIntegration(USER_SETTINGS, OPTIONS).settings
    expect(applyIntegration(once, OPTIONS).settings).toEqual(once)
  })

  it('replaces our old entry when the port changes, rather than adding a second', () => {
    const old = applyIntegration({}, { ...OPTIONS, port: 11111 }).settings
    const hooks = applyIntegration(old, OPTIONS).settings['hooks'] as HookGroups
    expect(hooks['Stop']).toHaveLength(1)
    expect(String(hooks['Stop']![0]!.hooks[0]!['url'])).toContain(':47821/')
  })

  it('installs no status line and adds only the token env var beside existing ones', () => {
    const { settings, conflicts } = applyIntegration({ env: { OTHER: 'x' } }, OPTIONS)
    expect(settings['statusLine']).toBeUndefined()
    expect(settings['env']).toEqual({ OTHER: 'x', CLAUDESWITCHER_TOKEN: 'abc123' })
    expect(conflicts).toEqual([])
  })

  it('leaves a foreign status line alone without reporting a conflict', () => {
    const { settings, conflicts } = applyIntegration({ statusLine: FOREIGN_STATUS_LINE }, OPTIONS)
    expect(settings['statusLine']).toEqual(FOREIGN_STATUS_LINE)
    expect(conflicts).toEqual([])
  })

  it('removes the status line and the port env var an earlier version installed, on reinstall', () => {
    const reinstalled = applyIntegration(olderInstall({ env: { OTHER: 'x' } }), OPTIONS).settings
    expect(reinstalled['statusLine']).toBeUndefined()
    expect(reinstalled['env']).toEqual({ OTHER: 'x', CLAUDESWITCHER_TOKEN: 'abc123' })
    expect(reinstalled).toEqual(applyIntegration({ env: { OTHER: 'x' } }, OPTIONS).settings)
  })

  it('keeps a foreign status line that replaced ours after the install, through reinstall and uninstall', () => {
    // The user replaced our status line with their own: from then on it is not ours.
    const replaced = { ...olderInstall(USER_SETTINGS), statusLine: FOREIGN_STATUS_LINE }
    const reinstalled = applyIntegration(replaced, OPTIONS).settings
    expect(reinstalled['statusLine']).toEqual(FOREIGN_STATUS_LINE)
    expect(removeIntegration(reinstalled)).toEqual({ ...USER_SETTINGS, statusLine: FOREIGN_STATUS_LINE })
    expect(removeIntegration(replaced)).toEqual({ ...USER_SETTINGS, statusLine: FOREIGN_STATUS_LINE })
  })

  it('leaves a malformed hooks value alone and reports it', () => {
    const { settings, conflicts } = applyIntegration({ hooks: 'nonsense' }, OPTIONS)
    expect(settings['hooks']).toBe('nonsense')
    expect(conflicts.length).toBeGreaterThan(0)
  })

  it('does not mistake another repo\'s statusline for ours', () => {
    // The path layout is not ours but common. With recognition by path, both install and uninstall
    // would take this foreign status line away.
    const { settings } = applyIntegration({ statusLine: FOREIGN_STATUS_LINE }, OPTIONS)
    expect(settings['statusLine']).toEqual(FOREIGN_STATUS_LINE)
    expect(removeIntegration(settings)).toEqual({ statusLine: FOREIGN_STATUS_LINE })
  })

  it('keeps a foreign hook that sits inside our own matcher group', () => {
    // When editing by hand this is the natural move: adding your own command to the existing
    // `hooks` array. Dropping at group level would take it away too.
    const installed = applyIntegration({}, OPTIONS).settings as { hooks: HookGroups }
    const theirs = { type: 'command', command: 'their-beep' }
    installed.hooks['Stop']![0]!.hooks.push(theirs)

    const hooks = applyIntegration(installed, OPTIONS).settings['hooks'] as HookGroups
    const survivors = hooks['Stop']!.flatMap((group) => group.hooks)
    expect(survivors).toContainEqual(theirs)
    expect(removeIntegration({ hooks })).toEqual({ hooks: { Stop: [{ hooks: [theirs] }] } })
  })

  it('still recognises our hook after its allowedEnvVars is pruned', () => {
    // allowedEnvVars is not a condition for running, so it can go missing. Without the fallback
    // the entry would be an unrecognisable orphan, and every install would duplicate it.
    const installed = applyIntegration({}, OPTIONS).settings as { hooks: HookGroups }
    delete installed.hooks['Stop']![0]!.hooks[0]!['allowedEnvVars']

    const hooks = applyIntegration(installed, OPTIONS).settings['hooks'] as HookGroups
    expect(hooks['Stop']).toHaveLength(1)
    expect(removeIntegration({ hooks })['hooks']).toBeUndefined()
  })

  it('does not claim a loopback hook that is not spoken over http', () => {
    // `new URL` fills in the host and the path for any scheme, so without a protocol check such a
    // foreign entry would count as ours too, and the install would silently take it away.
    const theirs = { type: 'command', url: 'file://127.0.0.1/hooks/notification' }
    const existing = { hooks: { Notification: [{ hooks: [theirs] }] } }

    const hooks = applyIntegration(existing, OPTIONS).settings['hooks'] as HookGroups
    expect(hooks['Notification']!.flatMap((group) => group.hooks)).toContainEqual(theirs)
    expect(removeIntegration({ hooks })).toEqual(existing)
  })

  it('keeps a foreign loopback hook on our path but another port, through install and uninstall', () => {
    // Another local tool may use the same path. Without the port the fallback recognition would take
    // it for ours, and the install would silently delete it.
    const theirs = { type: 'http', url: 'http://127.0.0.1:8080/hooks/notification' }
    const existing = { hooks: { Notification: [{ hooks: [theirs] }] } }

    const hooks = applyIntegration(existing, OPTIONS).settings['hooks'] as HookGroups
    expect(hooks['Notification']!.flatMap((group) => group.hooks)).toContainEqual(theirs)
    expect(removeIntegration({ hooks })).toEqual(existing)
  })

  it('gives PermissionRequest the 600 s timeout the decision broker releases inside', () => {
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as HookGroups
    const permission = hooks['PermissionRequest']![0]!.hooks[0]!
    expect(permission['url']).toBe('http://127.0.0.1:47821/hooks/permission-request')
    expect(permission['timeout']).toBe(600)
    expect(hooks['PreToolUse']![0]!.hooks[0]!['timeout']).toBe(5)
  })

  it('no longer installs SessionStart, which never fires as an http hook', () => {
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as Record<string, unknown>
    expect(hooks['SessionStart']).toBeUndefined()
  })

  it('removes the SessionStart entry an earlier version installed, keeping a foreign one', () => {
    // The earlier version's own entry: it refers to the token and points to the old route.
    const legacy = {
      hooks: [
        {
          type: 'http',
          url: 'http://127.0.0.1:47821/hooks/lifecycle/start',
          allowedEnvVars: ['CLAUDESWITCHER_TOKEN'],
        },
      ],
    }
    const installedBefore = { hooks: { SessionStart: [legacy] } }
    const reinstalled = applyIntegration(installedBefore, OPTIONS).settings['hooks'] as Record<string, unknown>
    expect(reinstalled['SessionStart']).toBeUndefined()

    const withForeign = { hooks: { SessionStart: [legacy, FOREIGN_NOTIFICATION] } }
    expect(removeIntegration(withForeign)).toEqual({ hooks: { SessionStart: [FOREIGN_NOTIFICATION] } })
  })

  it('recognises its own hook on every new route, even with allowedEnvVars pruned', () => {
    for (const route of ['permission-request', 'pre-tool-use', 'post-tool-use', 'subagent-stop']) {
      const ours = { type: 'http', url: `http://127.0.0.1:47821/hooks/${route}` }
      expect(removeIntegration({ hooks: { PreToolUse: [{ hooks: [ours] }] } })).toEqual({})
    }
  })
})

describe('removeIntegration', () => {
  it('restores the real settings exactly after an install', () => {
    // The most important property: install + uninstall together lose nothing.
    const installed = applyIntegration(USER_SETTINGS, OPTIONS).settings
    expect(removeIntegration(installed)).toEqual(USER_SETTINGS)
  })

  it('keeps foreign hooks, foreign env vars and a foreign status line', () => {
    const existing = {
      hooks: { Notification: [FOREIGN_NOTIFICATION] },
      env: { OTHER: 'x' },
      statusLine: FOREIGN_STATUS_LINE,
    }
    const installed = applyIntegration(existing, OPTIONS).settings
    expect(removeIntegration(installed)).toEqual(existing)
  })

  it('removes the status line and the port env var an earlier version installed', () => {
    expect(removeIntegration(olderInstall(USER_SETTINGS))).toEqual(USER_SETTINGS)
    const withForeignEnv = olderInstall({ ...USER_SETTINGS, env: { OTHER: 'x' } })
    expect(removeIntegration(withForeignEnv)).toEqual({ ...USER_SETTINGS, env: { OTHER: 'x' } })
  })

  it('is harmless on settings that never had the integration', () => {
    expect(removeIntegration(USER_SETTINGS)).toEqual(USER_SETTINGS)
  })
})

describe('hookInstallState', () => {
  const installed = (): Record<string, unknown> => applyIntegration({}, OPTIONS).settings
  const installedHooks = (): HookGroups => installed()['hooks'] as HookGroups
  /** The settings with these hooks and the install's token. */
  const withHooks = (hooks: unknown): Record<string, unknown> => ({ ...installed(), hooks })
  const stateOf = (settings: Record<string, unknown>) => hookInstallState(settings, OPTIONS.token)

  it('reports a fresh install as current', () => {
    expect(stateOf(installed())).toEqual({ kind: 'current' })
  })

  it('reports no integration when none of our hooks is there, foreign ones included', () => {
    expect(stateOf({})).toEqual({ kind: 'not-installed' })
    expect(stateOf(withHooks({}))).toEqual({ kind: 'not-installed' })
    expect(stateOf(withHooks({ Notification: [FOREIGN_NOTIFICATION] }))).toEqual({ kind: 'not-installed' })
  })

  it('lists the events an older install lacks', () => {
    // An install from before the two failure events were added: they are not in it.
    const older = without(installedHooks(), ['PostToolUseFailure', 'StopFailure'])
    expect(stateOf(withHooks(older))).toEqual({
      kind: 'stale',
      missing: ['StopFailure', 'PostToolUseFailure'],
      tokenMismatch: false,
    })
  })

  it('counts our hook on the wrong route or the wrong port as missing', () => {
    const hooks = installedHooks()
    const wrongRoute = { ...hooks['Stop']![0]!.hooks[0]!, url: 'http://127.0.0.1:47821/hooks/lifecycle/end' }
    const wrongPort = { ...hooks['PreToolUse']![0]!.hooks[0]!, url: 'http://127.0.0.1:11111/hooks/pre-tool-use' }
    const state = stateOf(withHooks({ ...hooks, Stop: [{ hooks: [wrongRoute] }], PreToolUse: [{ hooks: [wrongPort] }] }))
    expect(state).toEqual({ kind: 'stale', missing: ['Stop', 'PreToolUse'], tokenMismatch: false })
  })

  it('finds our hook beside foreign ones in the same event', () => {
    const hooks = installedHooks()
    expect(stateOf(withHooks({ ...hooks, Notification: [FOREIGN_NOTIFICATION, ...hooks['Notification']!] }))).toEqual({
      kind: 'current',
    })
  })

  it('reports our hooks with another token as stale, since every hook would get a 401', () => {
    // A settings.json brought from another machine carries that machine's token.
    expect(hookInstallState(installed(), 'def456')).toEqual({ kind: 'stale', missing: [], tokenMismatch: true })
    expect(stateOf(without(installed(), ['env']))).toEqual({ kind: 'stale', missing: [], tokenMismatch: true })
  })

  it('does not report a token problem when none of our hooks is there', () => {
    expect(hookInstallState({ env: { CLAUDESWITCHER_TOKEN: 'def456' } }, OPTIONS.token)).toEqual({ kind: 'not-installed' })
  })
})

describe('integrationNotice', () => {
  it('names the missing hook count and a wrong token only for a stale install', () => {
    expect(integrationNotice({ kind: 'stale', missing: ['PostToolUseFailure', 'StopFailure'], tokenMismatch: false })).toBe(
      'Integráció elavult, telepítsd újra (2 hiányzó hook)',
    )
    expect(integrationNotice({ kind: 'stale', missing: [], tokenMismatch: true })).toBe(
      'Integráció elavult, telepítsd újra (rossz token)',
    )
    expect(integrationNotice({ kind: 'stale', missing: ['Stop'], tokenMismatch: true })).toBe(
      'Integráció elavult, telepítsd újra (1 hiányzó hook, rossz token)',
    )
    expect(integrationNotice({ kind: 'current' })).toBeUndefined()
    expect(integrationNotice({ kind: 'not-installed' })).toBeUndefined()
    expect(integrationNotice({ kind: 'unknown' })).toBeUndefined()
  })
})

describe('readHookInstallState on a real file', () => {
  it('reads a fresh install as current, and an absent file as not installed', async () => {
    const dir = await tempDir('cs-setup-')
    expect(await readHookInstallState(dir, OPTIONS.token)).toEqual({ kind: 'not-installed' })
    await installIntegration(dir, OPTIONS)
    expect(await readHookInstallState(dir, OPTIONS.token)).toEqual({ kind: 'current' })
    expect(await readHookInstallState(dir, 'def456')).toEqual({ kind: 'stale', missing: [], tokenMismatch: true })
  })

  it('treats an unreadable or unparsable file as unknown, not as stale', async () => {
    const dir = await tempDir('cs-setup-')
    await writeFile(path.join(dir, 'settings.json'), '{ not json')
    expect(await readHookInstallState(dir, OPTIONS.token)).toEqual({ kind: 'unknown' })

    const asDir = await tempDir('cs-setup-')
    await mkdir(path.join(asDir, 'settings.json'))
    expect(await readHookInstallState(asDir, OPTIONS.token)).toEqual({ kind: 'unknown' })
  })

  it('never writes the file it reads', async () => {
    const dir = await tempDir('cs-setup-')
    const file = path.join(dir, 'settings.json')
    const raw = JSON.stringify({ hooks: { Notification: [FOREIGN_NOTIFICATION] } })
    await writeFile(file, raw)
    await readHookInstallState(dir, OPTIONS.token)
    expect(await readFile(file, 'utf8')).toBe(raw)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})

describe('installIntegration and uninstallIntegration on a real file', () => {
  it('round-trips the real settings through the file system unchanged', async () => {
    const dir = await tempDir('cs-setup-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify(USER_SETTINGS, null, 2))

    expect(await installIntegration(dir, OPTIONS)).toEqual([])
    await uninstallIntegration(dir)

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(USER_SETTINGS)
  })
})
