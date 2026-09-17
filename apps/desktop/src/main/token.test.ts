import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOrCreateToken } from './token.js'

describe('loadOrCreateToken', () => {
  it('creates a 32-hex-character token when none exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-token-'))
    expect(await loadOrCreateToken(dir)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns the same token on every later call', async () => {
    // A telepített settings.json `env` blokkja ezt a tokent kapja. Ha újraindításonként
    // változna, minden újraindítás elavulttá tenné a telepítést.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-token-'))
    const first = await loadOrCreateToken(dir)
    expect(await loadOrCreateToken(dir)).toBe(first)
  })

  it('replaces a token file that does not hold a valid token', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-token-'))
    await writeFile(path.join(dir, 'daemon-token'), 'not a token')
    const token = await loadOrCreateToken(dir)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect((await readFile(path.join(dir, 'daemon-token'), 'utf8')).trim()).toBe(token)
  })
})
