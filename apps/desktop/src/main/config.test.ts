import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY } from '../shared/settings.js'
import { configPath, loadConfig, saveSettings } from './config.js'
import { tempDir } from './test-helpers.js'

const freshDir = (): Promise<string> => tempDir('cs-config-')

const DEFAULTS = { hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: true, jumpToTab: true }

/** Values only: most tests do not care which settings were confirmed. */
async function loadValues(dir: string): Promise<Awaited<ReturnType<typeof loadConfig>>['values']> {
  return (await loadConfig(dir)).values
}

describe('loadConfig', () => {
  it('writes a config file with the defaults when none exists', async () => {
    const dir = await freshDir()
    expect(await loadValues(dir)).toEqual(DEFAULTS)
    // Ki is kell írnia, különben a felhasználó nem tudja, mit szerkeszthet.
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual(DEFAULTS)
  })

  it('returns the hotkey the user set', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'Control+Shift+F9' }))
    expect((await loadValues(dir)).hotkey).toBe('Control+Shift+F9')
  })

  it('loads an older file without the auto-hide key with its default, keeping the hotkey and the file', async () => {
    // Egy M1-es config fájlban még nincs `hideAfterLastDecision`. Nem írjuk át: a kulcs
    // hiánya az alapértéket jelenti, és a kézi szerkesztés érintetlen marad.
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'Control+Shift+F9' })
    await writeFile(configPath(dir), older)
    expect(await loadValues(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: true, jumpToTab: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('loads a part B file without the tab-jump key with its default, keeping its other keys and the file', async () => {
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false })
    await writeFile(configPath(dir), older)
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('returns the tab-jump setting the user turned off', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', jumpToTab: false }))
    expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: false })
  })

  it('ignores a tab-jump value that is not a boolean, without losing the other keys', async () => {
    for (const bad of ['false', 0, null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: false, jumpToTab: true })
    }
  })

  it('returns the auto-hide setting the user turned off', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: false }))
    expect((await loadValues(dir)).hideAfterLastDecision).toBe(false)
  })

  it('reads each setting on its own — a bad hotkey does not lose a valid auto-hide value', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 42, hideAfterLastDecision: false }))
    expect(await loadValues(dir)).toEqual({ hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: false, jumpToTab: true })
  })

  it('ignores an auto-hide value that is not a boolean', async () => {
    for (const bad of ['false', 0, null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: bad }))
      expect(await loadValues(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true, jumpToTab: true })
    }
  })

  it('falls back to the default on an unparseable file, without overwriting it', async () => {
    // Az app indulása nem bukhat el egy elrontott kézi szerkesztés miatt, és a fájlt sem
    // írjuk felül — a felhasználó szerkesztése maradjon meg, hogy ki tudja javítani.
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
    // Egy írhatatlan userData könyvtár se akadályozza meg az indulást: a gyorsbillentyű
    // ilyenkor az alapértelmezett, és az app fut.
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
    expect(config.values).toEqual({ hotkey: 'Shift+Alt+K', hideAfterLastDecision: false, jumpToTab: true })
    expect(config.confirmed.size).toBe(0)
  })

  it('ignores unknown and malformed confirmed entries', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ confirmed: ['jumpToTab', 'bogus', 3, 'jumpToTab'] }))
    expect([...(await loadConfig(dir)).confirmed]).toEqual(['jumpToTab'])

    await writeFile(configPath(dir), JSON.stringify({ confirmed: 'jumpToTab' }))
    expect((await loadConfig(dir)).confirmed.size).toBe(0)
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
    // A fájlt frissen olvassuk be, nem a memóriabeli configot írjuk ki: ha a felhasználó
    // indulás óta átírta a gyorsbillentyűt (újraindítás után él), az a pipától nem veszhet el.
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'Control+Shift+F9', note: 'kézzel' }))
    expect(await saveSettings(dir, { hideAfterLastDecision: false }, [])).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({
      hotkey: 'Control+Shift+F9',
      note: 'kézzel',
      hideAfterLastDecision: false,
    })
    expect(await loadValues(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: false, jumpToTab: true })
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
    // Ugyanaz a garancia, mint a betöltésnél: egy elrontott kézi szerkesztést nem írunk felül.
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
    // A két tálcapipa egymás után, várakozás nélkül hívja. Sorbaállítás nélkül a második a
    // régi tartalmat olvasná, és az első változás elveszne.
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
    // Egy könyvtár a config helyén nem ENOENT olvasási hibát ad: ez nem „nincs meg".
    const dir = await freshDir()
    await mkdir(configPath(dir))

    await expect(saveSettings(dir, { jumpToTab: false }, [])).resolves.toBe(false)
    await expect(loadValues(dir)).resolves.toEqual(DEFAULTS)
    expect(await readdir(dir)).toEqual(['config.json'])
  })
})
