import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
})
