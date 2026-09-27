import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY, configPath, loadConfig } from './config.js'

const freshDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'cs-config-'))

describe('loadConfig', () => {
  it('writes a config file with the default hotkey when none exists', async () => {
    const dir = await freshDir()
    expect((await loadConfig(dir)).hotkey).toBe(DEFAULT_HOTKEY)
    // Ki is kell írnia, különben a felhasználó nem tudja, mit szerkeszthet.
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({ hotkey: DEFAULT_HOTKEY })
  })

  it('returns the hotkey the user set', async () => {
    const dir = await freshDir()
    await writeFile(configPath(dir), JSON.stringify({ hotkey: 'Control+Shift+F9' }))
    expect((await loadConfig(dir)).hotkey).toBe('Control+Shift+F9')
  })

  it('falls back to the default on an unparseable file, without overwriting it', async () => {
    // Az app indulása nem bukhat el egy elrontott kézi szerkesztés miatt, és a fájlt sem
    // írjuk felül — a felhasználó szerkesztése maradjon meg, hogy ki tudja javítani.
    const dir = await freshDir()
    await writeFile(configPath(dir), '{ broken')
    expect((await loadConfig(dir)).hotkey).toBe(DEFAULT_HOTKEY)
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
    await expect(loadConfig(unusable)).resolves.toEqual({ hotkey: DEFAULT_HOTKEY })
  })
})
