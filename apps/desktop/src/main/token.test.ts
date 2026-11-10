import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tempDir } from '@claudeswitcher/core/testing'
import { isToken } from '@claudeswitcher/daemon'
import { describe, expect, it } from 'vitest'
import { loadOrCreateToken } from './token.js'

describe('loadOrCreateToken', () => {
  it('throws on a read error other than a missing file, instead of rotating the token', async () => {
    // A transient read error must not replace the token: every installed hook would get a 401.
    // A directory in place of the token gives a real read error other than ENOENT (EISDIR).
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
    // The `env` block of the installed settings.json gets this token. If it changed on every
    // restart, every restart would make the install stale.
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
