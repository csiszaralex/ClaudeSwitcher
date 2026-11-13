import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tempDir } from '@claudeswitcher/core/testing'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY, settingsToAsk } from '../shared/settings.js'
import { configPath, loadConfig, saveSettings, saveSkippedVersion } from './config.js'

const freshDir = (): Promise<string> => tempDir('cs-config-')

const DEFAULTS = { hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: true, jumpToTab: true, checkForUpdates: true }

/** Values only: most tests do not care which settings were confirmed. */
async function loadValues(dir: string): Promise<Awaited<ReturnType<typeof loadConfig>>['values']> {
  return (await loadConfig(dir)).values
}

describe('loadConfig', () => {
  it('writes a config file with the defaults when none exists', async () => {
    const dir = await freshDir()
    expect(await loadValues(dir)).toEqual(DEFAULTS)
    // It has to write the file too, otherwise the user does not know what can be edited.
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual(DEFAULTS)
  })

  it('returns the hotkey the user set', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'Control+Shift+F9' }))
    expect((await loadValues(dir)).hotkey).toBe('Control+Shift+F9')
  })

  it('loads an older file without the auto-hide key with its default, keeping the hotkey and the file', async () => {
    // A config file from the first release has no `hideAfterLastDecision` yet. It is not
    // rewritten: the missing key means the default, and the manual edit stays untouched.
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'Control+Shift+F9' })
    await writeFile(configPath(dir), older)
    expect(await loadValues(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: true, jumpToTab: true, checkForUpdates: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('loads a part B file without the tab-jump key with its default, keeping its other keys and the file', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false })
    await writeFile(configPath(dir), older)
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: true, checkForUpdates: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('loads a file from before the update check with its default, keeping its other keys and the file', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: false })
    await writeFile(configPath(dir), older)
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: false, checkForUpdates: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('returns the update check the user turned off, and ignores a value that is not a boolean', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', checkForUpdates: false }))
    expect((await loadValues(dir)).checkForUpdates).toBe(false)
    for (const bad of ['false', 0, null, {}]) {
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', jumpToTab: false, checkForUpdates: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: false, checkForUpdates: true })
    }
  })

  it('returns the tab-jump setting the user turned off', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', jumpToTab: false }))
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: false, checkForUpdates: true })
  })

  it('ignores a tab-jump value that is not a boolean, without losing the other keys', async () => {
    for (const bad of ['false', 0, null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: true, checkForUpdates: true })
    }
  })

  it('returns the auto-hide setting the user turned off', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: false }))
    expect((await loadValues(dir)).hideAfterLastDecision).toBe(false)
  })

  it('reads each setting on its own: a bad hotkey does not lose a valid auto-hide value', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 42, hideAfterLastDecision: false }))
    expect(await loadValues(dir)).toEqual({ hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: false, jumpToTab: true, checkForUpdates: true })
  })

  it('ignores an auto-hide value that is not a boolean', async () => {
    for (const bad of ['false', 0, null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: true, checkForUpdates: true })
    }
  })

  it('falls back to the default on an unparseable file, without overwriting it', async () => {
    // The app's startup must not fail because of a broken manual edit, and the file is not
    // overwritten either: the user's edit stays, so the user can fix it.
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect(await loadValues(dir)).toEqual(DEFAULTS)
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ broken')
  })

  it('ignores a hotkey that is not a non-empty string', async () => {
    for (const bad of [42, '', '   ', null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: bad }))
      expect((await loadValues(dir)).hotkey).toBe(DEFAULT_HOTKEY)
    }
  })

  it('never throws when the directory cannot be used', async () => {
    // An unwritable userData directory must not stop the startup either: the hotkey is then the
    // default, and the app runs.
    const dir = await freshDir()
    const unusable = path.join(dir, 'file-not-a-dir')
    await writeFile(unusable, 'x')
    await expect(loadValues(unusable)).resolves.toEqual(DEFAULTS)
  })
})

describe('confirmed settings', () => {
  it('an existing config without confirmed keys loads as unconfirmed', async () => {
    const dir = await freshDir()
    await writeFile(
      configPath(dir),
      JSON.stringify({ hotkey: 'Shift+Alt+K', hideAfterLastDecision: false, jumpToTab: true }),
    )
    const config = await loadConfig(dir)
    expect(config.values).toEqual({ hotkey: 'Shift+Alt+K', hideAfterLastDecision: false, jumpToTab: true, checkForUpdates: true })
    expect(config.confirmed.size).toBe(0)
  })

  it('leaves the update check unconfirmed in a file that confirmed every earlier setting', async () => {
    // The update that adds the setting: the first-run window asks exactly this one, once.
    const dir = await freshDir()
    await writeFile(
      configPath(dir),
      JSON.stringify({
        hotkey: 'F9',
        hideAfterLastDecision: false,
        jumpToTab: false,
        confirmed: ['autostart', 'hideAfterLastDecision', 'jumpToTab', 'hotkey'],
      }),
    )
    const config = await loadConfig(dir)
    expect(config.values).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: false, checkForUpdates: true })
    expect([...config.confirmed]).toEqual(['autostart', 'hideAfterLastDecision', 'jumpToTab', 'hotkey'])
    expect(settingsToAsk(config.confirmed, { installed: true })).toEqual(['checkForUpdates'])
  })

  it('ignores unknown and malformed confirmed entries', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ confirmed: ['jumpToTab', 'bogus', 3, 'jumpToTab'] }))
    expect([...(await loadConfig(dir)).confirmed]).toEqual(['jumpToTab'])

    await writeFile(configPath(dir), JSON.stringify({ confirmed: 'jumpToTab' }))
    expect((await loadConfig(dir)).confirmed.size).toBe(0)
  })
})

describe('skipped update version', () => {
  it('an older config without the key skips nothing, and loads without a rewrite', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9' })
    await writeFile(configPath(dir), older)
    expect((await loadConfig(dir)).skippedVersion).toBeUndefined()
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('a missing file skips nothing', async () => {
    expect((await loadConfig(await freshDir())).skippedVersion).toBeUndefined()
  })

  it('returns a stored version and ignores a value that is not one', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ skippedVersion: '0.2.0' }))
    expect((await loadConfig(dir)).skippedVersion).toBe('0.2.0')
    for (const bad of [42, '', 'latest', '0.2', ' 0.2.0', null, ['0.2.0']]) {
      await writeFile(configPath(dir), JSON.stringify({ skippedVersion: bad }))
      expect((await loadConfig(dir)).skippedVersion).toBeUndefined()
    }
  })

  it('is not a setting: it is never confirmed and does not change the values', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ skippedVersion: '0.2.0', confirmed: ['skippedVersion'] }))
    const config = await loadConfig(dir)
    expect(config.values).toEqual(DEFAULTS)
    expect(config.confirmed.size).toBe(0)
  })

  it('saveSkippedVersion changes only that key, and a later settings save keeps it', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', note: 'kézzel', skippedVersion: '0.2.0' }))
    expect(await saveSkippedVersion(dir, '0.3.0')).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({ hotkey: 'F9', note: 'kézzel', skippedVersion: '0.3.0' })

    expect(await saveSettings(dir, { jumpToTab: false }, [])).toBe(true)
    expect((await loadConfig(dir)).skippedVersion).toBe('0.3.0')
  })

  it('saveSkippedVersion writes the defaults plus the version when there is no file yet', async () => {
    const dir = await freshDir()
    expect(await saveSkippedVersion(dir, '0.2.0')).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({ ...DEFAULTS, skippedVersion: '0.2.0' })
  })

  it('saveSkippedVersion never writes into a broken file and never throws', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect(await saveSkippedVersion(dir, '0.2.0')).toBe(false)
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ broken')
  })
})

describe('saveSettings', () => {
  it('merges confirmed keys and keeps foreign keys', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ own: 1, confirmed: ['hotkey'] }))
    expect(await saveSettings(dir, { jumpToTab: false }, ['jumpToTab'])).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toMatchObject({
      own: 1,
      jumpToTab: false,
      confirmed: ['jumpToTab', 'hotkey'],
    })
  })

  it('writes the confirmed keys deduplicated and in settings order', async () => {
    const dir = await freshDir()
    expect(await saveSettings(dir, {}, ['hotkey', 'autostart', 'hotkey'])).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toMatchObject({ confirmed: ['autostart', 'hotkey'] })
  })

  it('never writes into a broken file', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect(await saveSettings(dir, { jumpToTab: false }, ['jumpToTab'])).toBe(false)
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ broken')
  })

  it('changes only the given key, keeping the hotkey and any other key the user wrote', async () => {
    // The file is read fresh instead of writing out the config in memory: if the user changed the
    // hotkey since the startup (it takes effect after a restart), a checkbox must not lose it.
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'Control+Shift+F9', note: 'kézzel' }))
    expect(await saveSettings(dir, { hideAfterLastDecision: false }, [])).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({
      hotkey: 'Control+Shift+F9',
      note: 'kézzel',
      hideAfterLastDecision: false,
    })
    expect(await loadValues(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: false, jumpToTab: true, checkForUpdates: true })
  })

  it('merges the tab-jump key into the file, keeping the auto-hide value and the user keys', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false, note: 'kézzel' }))
    expect(await saveSettings(dir, { jumpToTab: false }, [])).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({
      hotkey: 'F9',
      hideAfterLastDecision: false,
      note: 'kézzel',
      jumpToTab: false,
    })
  })

  it('writes the defaults plus the change when there is no file yet', async () => {
    const dir = await freshDir()
    expect(await saveSettings(dir, { hideAfterLastDecision: false }, [])).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({ ...DEFAULTS, hideAfterLastDecision: false })
  })

  it('refuses to overwrite an unparseable file', async () => {
    // The same guarantee as on load: a broken manual edit is not overwritten.
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect(await saveSettings(dir, { hideAfterLastDecision: false }, [])).toBe(false)
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ broken')
  })

  it('never throws when the directory cannot be used', async () => {
    const dir = await freshDir()
    const unusable = path.join(dir, 'file-not-a-dir')
    await writeFile(unusable, 'x')
    await expect(saveSettings(unusable, { hideAfterLastDecision: false }, [])).resolves.toBe(false)
  })

  it('persists two updates that were not awaited one after the other', async () => {
    // The two tray checkboxes call it one after the other, without waiting. Without the queue the
    // second would read the old content, and the first change would be lost.
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9' }))

    const results = await Promise.all([
      saveSettings(dir, { hideAfterLastDecision: false }, []),
      saveSettings(dir, { jumpToTab: false }, []),
    ])

    expect(results).toEqual([true, true])
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({
      hotkey: 'F9',
      hideAfterLastDecision: false,
      jumpToTab: false,
    })
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it('does not overwrite a config it cannot read for a reason other than a missing file', async () => {
    // A directory in place of the config gives a read error other than ENOENT: that is not "missing".
    const dir = await freshDir()
    await mkdir(configPath(dir))

    await expect(saveSettings(dir, { jumpToTab: false }, [])).resolves.toBe(false)
    await expect(loadValues(dir)).resolves.toEqual(DEFAULTS)
    expect(await readdir(dir)).toEqual(['config.json'])
  })
})
