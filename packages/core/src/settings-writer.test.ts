import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSettings, updateSettingsFile } from './settings-writer.js'

describe('mergeSettings', () => {
  it('preserves unrelated keys', () => {
    const existing = {
      model: 'opus[1m]',
      effortLevel: 'xhigh',
      tui: 'fullscreen',
      permissions: { allow: ['Bash(pnpm build *)'] },
    }
    const out = mergeSettings(existing, { statusLine: { type: 'command', command: 'x' } })
    expect(out.model).toBe('opus[1m]')
    expect(out.effortLevel).toBe('xhigh')
    expect(out.tui).toBe('fullscreen')
    expect(out.permissions).toEqual({ allow: ['Bash(pnpm build *)'] })
    expect(out.statusLine).toEqual({ type: 'command', command: 'x' })
  })

  it('deep-merges nested objects instead of replacing them', () => {
    const existing = { permissions: { allow: ['a'], deny: ['b'] } }
    const out = mergeSettings(existing, { permissions: { ask: ['c'] } })
    expect(out.permissions).toEqual({ allow: ['a'], deny: ['b'], ask: ['c'] })
  })

  it('replaces arrays wholesale rather than concatenating', () => {
    const existing = { hooks: { Notification: [{ old: true }] } }
    const out = mergeSettings(existing, { hooks: { Notification: [{ fresh: true }] } })
    expect(out.hooks).toEqual({ Notification: [{ fresh: true }] })
  })

  it('does not mutate its inputs', () => {
    const existing = { permissions: { allow: ['a'] } }
    const frozen = JSON.stringify(existing)
    mergeSettings(existing, { permissions: { allow: ['b'] } })
    expect(JSON.stringify(existing)).toBe(frozen)
  })

  it('drops a __proto__ key instead of losing it into the prototype', () => {
    // JSON.parse kell: az objektum-literál `__proto__` kulcsát a parser
    // külön kezeli, és nem saját kulcsot hozna létre.
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    const out = mergeSettings({ model: 'opus' }, patch)
    expect(out).toEqual({ model: 'opus' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined()
  })
})

describe('updateSettingsFile', () => {
  it('creates the file when it does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await updateSettingsFile(file, { model: 'opus' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('merges into an existing file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ model: 'opus', tui: 'fullscreen' }))
    await updateSettingsFile(file, { statusLine: { type: 'command' } })
    const out = JSON.parse(await readFile(file, 'utf8'))
    expect(out).toEqual({
      model: 'opus',
      tui: 'fullscreen',
      statusLine: { type: 'command' },
    })
  })

  it('refuses to write when the existing file is unparseable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ this is not json')
    await expect(updateSettingsFile(file, { model: 'opus' })).rejects.toThrow(/parse/i)
    expect(await readFile(file, 'utf8')).toBe('{ this is not json')
  })

  it('serialises concurrent updates instead of interleaving them', async () => {
    // Sorbaállítás nélkül a három írás egymásba fésülődik, és a fájl
    // olvashatatlan JSON lesz — a pontos katasztrófa, amit ez a modul megelőz.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ model: 'opus' }))

    await Promise.all([
      updateSettingsFile(file, { statusLine: { type: 'command' } }),
      updateSettingsFile(file, { env: { CLAUDESWITCHER_PORT: '1' } }),
      updateSettingsFile(file, { hooks: { Stop: [] } }),
    ])

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      model: 'opus',
      statusLine: { type: 'command' },
      env: { CLAUDESWITCHER_PORT: '1' },
      hooks: { Stop: [] },
    })
  })

  it('keeps writing after a failed update on the same file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ broken')
    await expect(updateSettingsFile(file, { a: 1 })).rejects.toThrow(/parse/i)

    await writeFile(file, '{}')
    await updateSettingsFile(file, { b: 2 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ b: 2 })
  })

  it('leaves no temp files behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await updateSettingsFile(file, { model: 'opus' })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})
