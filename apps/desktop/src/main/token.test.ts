import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tempDir } from '@claudeswitcher/core/testing'
import { isToken } from '@claudeswitcher/daemon'
import { describe, expect, it } from 'vitest'
import { loadOrCreateToken } from './token.js'

describe('loadOrCreateToken', () => {
  it('throws on a read error other than a missing file, instead of rotating the token', async () => {
    // Egy átmeneti olvasási hiba nem cserélheti le a tokent: minden telepített hook 401-et kapna.
    // A könyvtár a token helyén valódi, nem ENOENT olvasási hibát ad (EISDIR).
    const dir = await tempDir('cs-token-')
    await mkdir(path.join(dir, 'daemon-token'))

    await expect(loadOrCreateToken(dir)).rejects.toThrow(/EISDIR/)
    expect(await readdir(dir)).toEqual(['daemon-token'])
  })

  it('creates a daemon token when none exists', async () => {
    const dir = await tempDir('cs-token-')
    expect(isToken(await loadOrCreateToken(dir))).toBe(true)
  })

  it('returns the same token on every later call', async () => {
    // A telepített settings.json `env` blokkja ezt a tokent kapja. Ha újraindításonként
    // változna, minden újraindítás elavulttá tenné a telepítést.
    const dir = await tempDir('cs-token-')
    const first = await loadOrCreateToken(dir)
    expect(await loadOrCreateToken(dir)).toBe(first)
  })

  it('replaces a token file that does not hold a valid token', async () => {
    const dir = await tempDir('cs-token-')
    await writeFile(path.join(dir, 'daemon-token'), 'not a token')
    const token = await loadOrCreateToken(dir)
    expect(isToken(token)).toBe(true)
    expect((await readFile(path.join(dir, 'daemon-token'), 'utf8')).trim()).toBe(token)
  })
})
