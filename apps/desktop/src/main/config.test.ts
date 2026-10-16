import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY, configPath, loadConfig, updateConfig } from './config.js'

const freshDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'cs-config-'))

const DEFAULTS = { hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: true }

describe('loadConfig', () => {
  it('writes a config file with the defaults when none exists', async () => {
    const dir = await freshDir()
    expect(await loadConfig(dir)).toEqual(DEFAULTS)
    // Ki is kell írnia, különben a felhasználó nem tudja, mit szerkeszthet.
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual(DEFAULTS)
  })

  it('returns the hotkey the user set', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'Control+Shift+F9' }))
    expect((await loadConfig(dir)).hotkey).toBe('Control+Shift+F9')
  })

  it('loads an older file without the auto-hide key with its default, keeping the hotkey and the file', async () => {
    // Egy M1-es config fájlban még nincs `hideAfterLastDecision`. Nem írjuk át: a kulcs
    // hiánya az alapértéket jelenti, és a kézi szerkesztés érintetlen marad.
    const dir = await freshDir()
    const older = JSON.stringify({ hotkey: 'Control+Shift+F9' })
    await writeFile(configPath(dir), older)
    expect(await loadConfig(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: true })
    expect(await readFile(configPath(dir), 'utf8')).toBe(older)
  })

  it('returns the auto-hide setting the user turned off', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: false }))
    expect((await loadConfig(dir)).hideAfterLastDecision).toBe(false)
  })

  it('reads each setting on its own — a bad hotkey does not lose a valid auto-hide value', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 42, hideAfterLastDecision: false }))
    expect(await loadConfig(dir)).toEqual({ hotkey: DEFAULT_HOTKEY, hideAfterLastDecision: false })
  })

  it('ignores an auto-hide value that is not a boolean', async () => {
    for (const bad of ['false', 0, null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: 'F9', hideAfterLastDecision: bad }))
      expect(await loadConfig(dir)).toEqual({ hotkey: 'F9', hideAfterLastDecision: true })
    }
  })

  it('falls back to the default on an unparseable file, without overwriting it', async () => {
    // Az app indulása nem bukhat el egy elrontott kézi szerkesztés miatt, és a fájlt sem
    // írjuk felül — a felhasználó szerkesztése maradjon meg, hogy ki tudja javítani.
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect(await loadConfig(dir)).toEqual(DEFAULTS)
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ broken')
  })

  it('ignores a hotkey that is not a non-empty string', async () => {
    for (const bad of [42, '', '   ', null, {}]) {
      const dir = await freshDir()
      await writeFile(configPath(dir), JSON.stringify({ hotkey: bad }))
      expect((await loadConfig(dir)).hotkey).toBe(DEFAULT_HOTKEY)
    }
  })

  it('never throws when the directory cannot be used', async () => {
    // Egy írhatatlan userData könyvtár se akadályozza meg az indulást: a gyorsbillentyű
    // ilyenkor az alapértelmezett, és az app fut.
    const dir = await freshDir()
    const unusable = path.join(dir, 'file-not-a-dir')
    await writeFile(unusable, 'x')
    await expect(loadConfig(unusable)).resolves.toEqual(DEFAULTS)
  })
})

describe('updateConfig', () => {
  it('changes only the given key, keeping the hotkey and any other key the user wrote', async () => {
    // A fájlt frissen olvassuk be, nem a memóriabeli configot írjuk ki: ha a felhasználó
    // indulás óta átírta a gyorsbillentyűt (újraindítás után él), az a pipától nem veszhet el.
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'Control+Shift+F9', note: 'kézzel' }))
    expect(await updateConfig(dir, { hideAfterLastDecision: false })).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({
      hotkey: 'Control+Shift+F9',
      note: 'kézzel',
      hideAfterLastDecision: false,
    })
    expect(await loadConfig(dir)).toEqual({ hotkey: 'Control+Shift+F9', hideAfterLastDecision: false })
  })

  it('writes the defaults plus the change when there is no file yet', async () => {
    const dir = await freshDir()
    expect(await updateConfig(dir, { hideAfterLastDecision: false })).toBe(true)
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({ ...DEFAULTS, hideAfterLastDecision: false })
  })

  it('refuses to overwrite an unparseable file', async () => {
    // Ugyanaz a garancia, mint a betöltésnél: egy elrontott kézi szerkesztést nem írunk felül.
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect(await updateConfig(dir, { hideAfterLastDecision: false })).toBe(false)
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ broken')
  })

  it('never throws when the directory cannot be used', async () => {
    const dir = await freshDir()
    const unusable = path.join(dir, 'file-not-a-dir')
    await writeFile(unusable, 'x')
    await expect(updateConfig(unusable, { hideAfterLastDecision: false })).resolves.toBe(false)
  })
})
