import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyIntegration,
  installIntegration,
  removeIntegration,
  uninstallIntegration,
} from './setup.js'

const OPTIONS = {
  port: 47821,
  token: 'abc123',
  statusLineCommand: 'node "P:\\repo\\packages\\statusline\\dist\\main.js"',
}

/** A felhasználó valódi settings.json-jának alakja, a munkamenet elején lemérve. */
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

const FOREIGN_STATUS_LINE = { type: 'command', command: 'bash ~/my-statusline.sh' }

type HookGroups = Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>

describe('applyIntegration', () => {
  it('leaves every existing key of the real settings untouched', () => {
    const { settings } = applyIntegration(USER_SETTINGS, OPTIONS)
    for (const [key, value] of Object.entries(USER_SETTINGS)) {
      expect(settings[key]).toEqual(value)
    }
  })

  it('installs only the four non-blocking hook events', () => {
    const hooks = applyIntegration({}, OPTIONS).settings.hooks as Record<string, unknown>
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'SessionEnd', 'SessionStart', 'Stop'])
    // A PermissionRequest az M2 hatásköre; az M1 egyetlen döntést sem vesz el.
    expect(hooks.PermissionRequest).toBeUndefined()
  })

  it('points each hook at the fixed loopback port with the token header', () => {
    const hooks = applyIntegration({}, OPTIONS).settings.hooks as HookGroups
    const hook = hooks.Notification![0]!.hooks[0]!
    expect(hook.type).toBe('http')
    expect(hook.url).toBe('http://127.0.0.1:47821/hooks/notification')
    expect(hook.timeout).toBe(5)
    expect((hook.headers as Record<string, string>).Authorization).toBe('Bearer $CLAUDESWITCHER_TOKEN')
    expect(hook.allowedEnvVars).toEqual(['CLAUDESWITCHER_TOKEN'])
  })

  it('keeps a foreign hook on the same event instead of overwriting it', () => {
    // Az eredeti terv a tömböt egészben cserélte, és ezt a hookot némán törölte volna.
    const existing = { hooks: { Notification: [FOREIGN_NOTIFICATION] } }
    const hooks = applyIntegration(existing, OPTIONS).settings.hooks as Record<string, unknown[]>
    expect(hooks.Notification).toHaveLength(2)
    expect(hooks.Notification![0]).toEqual(FOREIGN_NOTIFICATION)
  })

  it('is idempotent: installing twice changes nothing the second time', () => {
    const once = applyIntegration(USER_SETTINGS, OPTIONS).settings
    expect(applyIntegration(once, OPTIONS).settings).toEqual(once)
  })

  it('replaces our old entry when the port changes, rather than adding a second', () => {
    const old = applyIntegration({}, { ...OPTIONS, port: 11111 }).settings
    const hooks = applyIntegration(old, OPTIONS).settings.hooks as HookGroups
    expect(hooks.Stop).toHaveLength(1)
    expect(String(hooks.Stop![0]!.hooks[0]!.url)).toContain(':47821/')
  })

  it('installs the status line and adds the two env vars beside existing ones', () => {
    const { settings } = applyIntegration({ env: { OTHER: 'x' } }, OPTIONS)
    expect(settings.statusLine).toEqual({ type: 'command', command: OPTIONS.statusLineCommand, padding: 0 })
    expect(settings.env).toEqual({
      OTHER: 'x',
      CLAUDESWITCHER_PORT: '47821',
      CLAUDESWITCHER_TOKEN: 'abc123',
    })
  })

  it('refuses to overwrite a foreign status line and reports it as a conflict', () => {
    const { settings, conflicts } = applyIntegration({ statusLine: FOREIGN_STATUS_LINE }, OPTIONS)
    expect(settings.statusLine).toEqual(FOREIGN_STATUS_LINE)
    expect(conflicts).toHaveLength(1)
  })

  it('leaves a malformed hooks value alone and reports it', () => {
    const { settings, conflicts } = applyIntegration({ hooks: 'nonsense' }, OPTIONS)
    expect(settings.hooks).toBe('nonsense')
    expect(conflicts.length).toBeGreaterThan(0)
  })
})

describe('removeIntegration', () => {
  it('restores the real settings exactly after an install', () => {
    // A legfontosabb tulajdonság: telepítés + eltávolítás együtt veszteségmentes.
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

  it('is harmless on settings that never had the integration', () => {
    expect(removeIntegration(USER_SETTINGS)).toEqual(USER_SETTINGS)
  })
})

describe('installIntegration and uninstallIntegration on a real file', () => {
  it('round-trips the real settings through the file system unchanged', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-setup-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify(USER_SETTINGS, null, 2))

    expect(await installIntegration(dir, OPTIONS)).toEqual([])
    await uninstallIntegration(dir)

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(USER_SETTINGS)
  })
})
