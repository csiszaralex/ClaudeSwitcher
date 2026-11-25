import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tempDir } from '@claudeswitcher/core/testing'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY, settingsToAsk } from '../shared/settings.js'
import { configPath, loadConfig, saveExcludedSessions, saveSettings, saveSkippedVersion } from './config.js'

const freshDir = (): Promise<string> => tempDir('cs-config-')

const DEFAULTS = { hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: true, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true }

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
    expect(await loadValues(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: true, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('loads a part B file without the tab-jump key with its default, keeping its other keys and the file', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false })
    await writeFile(configPath(dir), older)
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('loads a file from before the update check with its default, keeping its other keys and the file', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: false })
    await writeFile(configPath(dir), older)
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: false, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('returns the update check the user turned off, and ignores a value that is not a boolean', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', checkForUpdates: false }))
    expect((await loadValues(dir)).checkForUpdates).toBe(false)
    for (const bad of ['false', 0, null, {}]) {
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', jumpToTab: false, checkForUpdates: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: false, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
    }
  })

  it('returns the tab-jump setting the user turned off', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', jumpToTab: false }))
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: false, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
  })

  it('ignores a tab-jump value that is not a boolean, without losing the other keys', async () => {
    for (const bad of ['false', 0, null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
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
    expect(await loadValues(dir)).toEqual({ hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: false, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
  })

  it('ignores an auto-hide value that is not a boolean', async () => {
    for (const bad of ['false', 0, null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
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
    expect(config.values).toEqual({ hotkey: 'Shift+Alt+K', hideAfterLastDecision: false, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
    expect(config.confirmed.size).toBe(0)
  })

  it('leaves the update check and the notifications unconfirmed in a file that confirmed every earlier setting', async () => {
    // The update that adds the settings: the first-run window asks exactly these, once.
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
    expect(config.values).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: false, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
    expect([...config.confirmed]).toEqual(['autostart', 'hideAfterLastDecision', 'jumpToTab', 'hotkey'])
    expect(settingsToAsk(config.confirmed, { installed: true })).toEqual(['notifyOnRequest', 'notifyOnFinish', 'checkForUpdates'])
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

describe('excluded sessions', () => {
  // Invented session ids in the registry's UUID shape.
  const ALPHA = '6f1c2a3e-0000-4000-8000-000000000051'
  const BETA = '6f1c2a3e-0000-4000-8000-000000000052'
  const GAMMA = '6f1c2a3e-0000-4000-8000-000000000053'
  const alpha = { sessionId: ALPHA, whileRunning: false }
  const beta = { sessionId: BETA, whileRunning: true }

  it('an older config without the key excludes nothing, and loads without a rewrite', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9' })
    await writeFile(configPath(dir), older)
    expect((await loadConfig(dir)).excludedSessions).toEqual([])
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('a missing file excludes nothing', async () => {
    expect((await loadConfig(await freshDir())).excludedSessions).toEqual([])
  })

  it('reads the entries, each session once, the first one kept', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ excludedSessions: [alpha, beta, { sessionId: ALPHA, whileRunning: true }] }))
    expect((await loadConfig(dir)).excludedSessions).toEqual([alpha, beta])
  })

  it('reads a plain session id of an older file as excluded while idle, beside the entries', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ excludedSessions: [ALPHA, beta, ALPHA] }))
    expect((await loadConfig(dir)).excludedSessions).toEqual([alpha, beta])
  })

  it('drops a malformed item and keeps the rest, and reads anything but an array as none', async () => {
    const dir = await freshDir()
    const malformed = [42, '', null, true, [ALPHA], { id: BETA }, { sessionId: GAMMA }, { sessionId: GAMMA, whileRunning: 'yes' }, { sessionId: '', whileRunning: false }, { sessionId: 7, whileRunning: false }]
    await writeFile(configPath(dir), JSON.stringify({ excludedSessions: [...malformed, beta] }))
    expect((await loadConfig(dir)).excludedSessions).toEqual([beta])
    for (const bad of [ALPHA, 42, null, { 0: ALPHA }, true]) {
      await writeFile(configPath(dir), JSON.stringify({ excludedSessions: bad }))
      expect((await loadConfig(dir)).excludedSessions).toEqual([])
    }
  })

  it('is not a setting: it is never confirmed and does not change the values', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ excludedSessions: [ALPHA], confirmed: ['excludedSessions'] }))
    const config = await loadConfig(dir)
    expect(config.values).toEqual(DEFAULTS)
    expect(config.confirmed.size).toBe(0)
  })

  it('saveExcludedSessions changes only that key, and a later settings save keeps it', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', note: 'kézzel', skippedVersion: '0.2.0' }))
    expect(await saveExcludedSessions(dir, { excluded: [alpha, beta], due: [] })).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({
      hotkey: 'F9',
      note: 'kézzel',
      skippedVersion: '0.2.0',
      excludedSessions: [alpha, beta],
      dueSessions: [],
    })

    // The setup window's save goes through `saveSettings`.
    expect(await saveSettings(dir, { jumpToTab: false }, ['jumpToTab'])).toBe(true)
    expect((await loadConfig(dir)).excludedSessions).toEqual([alpha, beta])
  })

  it('stores only the two fields of an entry, so what it stores loads back the same', async () => {
    const dir = await freshDir()
    const wider = { ...beta, extra: 'nem kell' }
    expect(await saveExcludedSessions(dir, { excluded: [alpha, wider], due: [] })).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toMatchObject({ excludedSessions: [alpha, beta] })
    expect((await loadConfig(dir)).excludedSessions).toEqual([alpha, beta])
  })

  it('keeps the list of the last of two saves started without waiting', async () => {
    const dir = await freshDir()
    await Promise.all([saveExcludedSessions(dir, { excluded: [alpha, beta], due: [] }), saveExcludedSessions(dir, { excluded: [beta], due: [] })])
    expect((await loadConfig(dir)).excludedSessions).toEqual([beta])
  })

  it('saveExcludedSessions never writes into a broken file and never throws', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect(await saveExcludedSessions(dir, { excluded: [alpha], due: [] })).toBe(false)
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
    expect(await loadValues(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: false, jumpToTab: true, notifyOnRequest: true, notifyOnFinish: false, checkForUpdates: true })
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

describe('timed exclusions, due marks and the weekly reset', () => {
  // Invented session ids in the registry's UUID shape, and an invented time.
  const ALPHA = '6f1c2a3e-0000-4000-8000-000000000054'
  const BETA = '6f1c2a3e-0000-4000-8000-000000000055'
  const T = Date.parse('2026-11-26T07:00:00.000Z')

  it('reads an entry with a time, and a v0.26.0 entry without one as an exclusion without a time', async () => {
    const dir = await freshDir()
    const timed = { sessionId: ALPHA, whileRunning: true, until: T }
    const plain = { sessionId: BETA, whileRunning: false }
    await writeFile(configPath(dir), JSON.stringify({ excludedSessions: [timed, plain] }))
    expect((await loadConfig(dir)).excludedSessions).toEqual([timed, plain])
  })

  it('drops an entry whose time is there but not a finite number, so a misread time hides nothing', async () => {
    const dir = await freshDir()
    const plain = { sessionId: BETA, whileRunning: false }
    const bad = ['2026-11-26', null, true, { at: T }].map((until) => ({ sessionId: ALPHA, whileRunning: false, until }))
    await writeFile(configPath(dir), JSON.stringify({ excludedSessions: [...bad, plain] }))
    expect((await loadConfig(dir)).excludedSessions).toEqual([plain])
  })

  it('reads the due marks, each session once, and drops a malformed one', async () => {
    const dir = await freshDir()
    const mark = { sessionId: ALPHA, until: T }
    const malformed = [ALPHA, { sessionId: BETA }, { sessionId: BETA, until: 'holnap' }, { sessionId: '', until: T }, null]
    await writeFile(configPath(dir), JSON.stringify({ dueSessions: [...malformed, mark, { sessionId: ALPHA, until: T + 1 }] }))
    expect((await loadConfig(dir)).dueSessions).toEqual([mark])
    await writeFile(configPath(dir), JSON.stringify({ dueSessions: mark }))
    expect((await loadConfig(dir)).dueSessions).toEqual([])
  })

  it('an older config without the new keys has no due marks and no weekly reset, and loads without a rewrite', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9', excludedSessions: [{ sessionId: ALPHA, whileRunning: false }] })
    await writeFile(configPath(dir), older)
    const config = await loadConfig(dir)
    expect(config.dueSessions).toEqual([])
    expect(config.weeklyReset).toBeUndefined()
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('stores the time and the due marks in one write, and what it stores loads back the same', async () => {
    const dir = await freshDir()
    const timed = { sessionId: ALPHA, whileRunning: false, until: T }
    const mark = { sessionId: BETA, until: T - 60_000 }
    const wider = { ...mark, extra: 'nem kell' }
    expect(await saveExcludedSessions(dir, { excluded: [timed], due: [wider] })).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toMatchObject({ excludedSessions: [timed], dueSessions: [mark] })
    const config = await loadConfig(dir)
    expect(config.excludedSessions).toEqual([timed])
    expect(config.dueSessions).toEqual([mark])
  })

  it('reads the weekly reset the user wrote, with Sunday as 0 or 7', async () => {
    const dir = await freshDir()
    for (const [stored, read] of [
      [{ weekday: 4, time: '07:00' }, { weekday: 4, hour: 7, minute: 0 }],
      [{ weekday: 1, time: '9:30' }, { weekday: 1, hour: 9, minute: 30 }],
      [{ weekday: 7, time: '23:59' }, { weekday: 0, hour: 23, minute: 59 }],
      [{ weekday: 0, time: '00:00' }, { weekday: 0, hour: 0, minute: 0 }],
    ] as const) {
      await writeFile(configPath(dir), JSON.stringify({ weeklyReset: stored }))
      expect((await loadConfig(dir)).weeklyReset).toEqual(read)
    }
  })

  it('reads a malformed weekly reset as not set', async () => {
    const dir = await freshDir()
    const bad = [
      'csütörtök 7:00',
      4,
      { weekday: 4 },
      { time: '07:00' },
      { weekday: 8, time: '07:00' },
      { weekday: -1, time: '07:00' },
      { weekday: 4.5, time: '07:00' },
      { weekday: '4', time: '07:00' },
      { weekday: 4, time: '24:00' },
      { weekday: 4, time: '7:60' },
      { weekday: 4, time: '7' },
      { weekday: 4, time: 700 },
    ]
    for (const weeklyReset of bad) {
      await writeFile(configPath(dir), JSON.stringify({ weeklyReset }))
      expect((await loadConfig(dir)).weeklyReset).toBeUndefined()
    }
  })

  it('keeps the weekly reset through a settings save and a save of the excluded sessions', async () => {
    const dir = await freshDir()
    const weeklyReset = { weekday: 4, time: '07:00' }
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', weeklyReset }))
    expect(await saveSettings(dir, { jumpToTab: false }, ['jumpToTab'])).toBe(true)
    expect(await saveExcludedSessions(dir, { excluded: [], due: [{ sessionId: ALPHA, until: T }] })).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toMatchObject({ weeklyReset })
    expect((await loadConfig(dir)).weeklyReset).toEqual({ weekday: 4, hour: 7, minute: 0 })
  })
})
