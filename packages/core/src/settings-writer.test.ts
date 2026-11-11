import * as realFs from 'node:fs/promises'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_BACKUP_SUFFIX,
  isMissingPathError,
  isNotFoundError,
  mergeSettings,
  transformSettingsFile,
  updateSettingsFile,
  type SettingsFs,
} from './settings-writer.js'
import { tempDir } from './testing.js'

/** The real file system, with some operations overridden by the test. */
function fsWith(overrides: Partial<SettingsFs>): SettingsFs {
  return {
    readFile: (file, encoding) => realFs.readFile(file, encoding),
    writeFile: (file, data, encoding) => realFs.writeFile(file, data, encoding),
    rename: (from, to) => realFs.rename(from, to),
    unlink: (file) => realFs.unlink(file),
    copyFile: (from, to, mode) => realFs.copyFile(from, to, mode),
    ...overrides,
  }
}

function codedError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

describe('file error checks', () => {
  it('isNotFoundError takes only ENOENT, isMissingPathError also ENOTDIR', () => {
    expect(isNotFoundError(codedError('ENOENT'))).toBe(true)
    expect(isNotFoundError(codedError('ENOTDIR'))).toBe(false)
    expect(isMissingPathError(codedError('ENOENT'))).toBe(true)
    expect(isMissingPathError(codedError('ENOTDIR'))).toBe(true)
    for (const error of [codedError('EACCES'), new Error('no code'), { code: 'ENOENT' }, undefined]) {
      expect(isMissingPathError(error)).toBe(false)
    }
  })
})

describe('mergeSettings', () => {
  it('preserves unrelated keys', () => {
    const existing = {
      model: 'opus[1m]',
      effortLevel: 'xhigh',
      tui: 'fullscreen',
      permissions: { allow: ['Bash(pnpm build *)'] },
    }
    const out = mergeSettings(existing, { statusLine: { type: 'command', command: 'x' } })
    expect(out['model']).toBe('opus[1m]')
    expect(out['effortLevel']).toBe('xhigh')
    expect(out['tui']).toBe('fullscreen')
    expect(out['permissions']).toEqual({ allow: ['Bash(pnpm build *)'] })
    expect(out['statusLine']).toEqual({ type: 'command', command: 'x' })
  })

  it('deep-merges nested objects instead of replacing them', () => {
    const existing = { permissions: { allow: ['a'], deny: ['b'] } }
    const out = mergeSettings(existing, { permissions: { ask: ['c'] } })
    expect(out['permissions']).toEqual({ allow: ['a'], deny: ['b'], ask: ['c'] })
  })

  it('replaces arrays wholesale rather than concatenating', () => {
    const existing = { hooks: { Notification: [{ old: true }] } }
    const out = mergeSettings(existing, { hooks: { Notification: [{ fresh: true }] } })
    expect(out['hooks']).toEqual({ Notification: [{ fresh: true }] })
  })

  it('does not mutate its inputs', () => {
    const existing = { permissions: { allow: ['a'] } }
    const frozen = JSON.stringify(existing)
    mergeSettings(existing, { permissions: { allow: ['b'] } })
    expect(JSON.stringify(existing)).toBe(frozen)
  })

  it('drops a __proto__ key instead of losing it into the prototype', () => {
    // JSON.parse is needed: the parser treats a `__proto__` key in an object literal specially, and
    // it would not create an own key.
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    const out = mergeSettings({ model: 'opus' }, patch)
    expect(out).toEqual({ model: 'opus' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((({} as Record<string, unknown>)['polluted'])).toBeUndefined()
  })
})

describe('updateSettingsFile', () => {
  it('creates the file when it does not exist', async () => {
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await updateSettingsFile(file, { model: 'opus' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('merges into an existing file', async () => {
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ model: 'opus', tui: 'fullscreen' }))
    await updateSettingsFile(file, { statusLine: { type: 'command' } })
    const out: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect(out).toEqual({
      model: 'opus',
      tui: 'fullscreen',
      statusLine: { type: 'command' },
    })
  })

  it('refuses to write when the existing file is unparseable', async () => {
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ this is not json')
    await expect(updateSettingsFile(file, { model: 'opus' })).rejects.toThrow(/parse/i)
    expect(await readFile(file, 'utf8')).toBe('{ this is not json')
  })

  it('serialises concurrent updates instead of interleaving them', async () => {
    // Without the queue the three writes interleave and the file becomes unreadable JSON: the very
    // disaster this module prevents.
    const dir = await tempDir('cs-')
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
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ broken')
    await expect(updateSettingsFile(file, { a: 1 })).rejects.toThrow(/parse/i)

    await writeFile(file, '{}')
    await updateSettingsFile(file, { b: 2 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ b: 2 })
  })

  it('leaves no temp files behind', async () => {
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await updateSettingsFile(file, { model: 'opus' })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})

describe('transformSettingsFile', () => {
  it('passes the parsed file to the transform and writes its result', async () => {
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ keep: 1, drop: 2 }))

    await transformSettingsFile(file, (existing) => {
      const rest = Object.fromEntries(Object.entries(existing).filter(([k]) => k !== 'drop'))
      return rest
    })

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ keep: 1 })
  })

  it('can remove nested keys, which a merge patch cannot express', async () => {
    // The reason it exists at all: removal deletes keys, mergeSettings only adds.
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ env: { A: '1', B: '2' } }))
    await transformSettingsFile(file, () => ({ env: { A: '1' } }))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ env: { A: '1' } })
  })

  it('refuses to write an unparseable file and never calls the transform', async () => {
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ broken')
    let called = false
    await expect(
      transformSettingsFile(file, (existing) => {
        called = true
        return existing
      }),
    ).rejects.toThrow(/parse/i)
    expect(called).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('{ broken')
  })

  it('shares one write queue with updateSettingsFile', async () => {
    // Without a shared queue an install and a concurrent merge would drop each other's writes.
    const dir = await tempDir('cs-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({}))

    await Promise.all([
      updateSettingsFile(file, { a: 1 }),
      transformSettingsFile(file, (existing) => ({ ...existing, b: 2 })),
      updateSettingsFile(file, { c: 3 }),
    ])

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1, b: 2, c: 3 })
  })
})

describe('transformSettingsFile never loses the existing settings', () => {
  const ORIGINAL = JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }, null, 2)

  it('refuses to write when the read fails with anything but ENOENT', async () => {
    // A busy file (EBUSY) is not "missing": it used to become `{}`, and the install overwrote the
    // user's whole settings with only our keys.
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, ORIGINAL)
    let called = false
    const fs = fsWith({ readFile: () => Promise.reject(codedError('EBUSY')) })

    await expect(
      transformSettingsFile(file, (existing) => {
        called = true
        return existing
      }, { fs }),
    ).rejects.toThrow(/EBUSY/)

    expect(called).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(ORIGINAL)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('retries an empty read and writes once the content shows up', async () => {
    // Another writer has just truncated the file: the next read already sees the full content.
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, ORIGINAL)
    let reads = 0
    const fs = fsWith({
      readFile: (target, encoding) => {
        reads += 1
        return reads === 1 ? Promise.resolve('  \n') : realFs.readFile(target, encoding)
      },
    })

    await updateSettingsFile(file, { statusLine: { type: 'command' } }, { fs })

    expect(reads).toBeGreaterThan(1)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      statusLine: { type: 'command' },
    })
  })

  it('refuses to write a file that stays empty instead of treating it as {}', async () => {
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '')
    let called = false

    await expect(
      transformSettingsFile(file, (existing) => {
        called = true
        return existing
      }),
    ).rejects.toThrow(/empty/i)

    expect(called).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('')
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('redoes the write when another writer changed the file meanwhile, keeping its keys', async () => {
    // Claude Code or an editor writes the file between our read and our rename. The content
    // comparison before the rename notices it, and the cycle runs again on their content.
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, ORIGINAL)
    let interfered = false
    const fs = fsWith({
      writeFile: async (target, data, encoding) => {
        if (!interfered && target !== file) {
          interfered = true
          await realFs.writeFile(file, JSON.stringify({ model: 'sonnet', theirs: true }), 'utf8')
        }
        await realFs.writeFile(target, data, encoding)
      },
    })

    await updateSettingsFile(file, { ours: 1 }, { fs, backup: false })

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'sonnet', theirs: true, ours: 1 })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('redoes the write when another writer left a file of the same size within one mtime tick', async () => {
    // A timestamp and a size cannot tell this change apart, so only the content can.
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ effort: 'low' }))
    let interfered = false
    const fs = fsWith({
      writeFile: async (target, data, encoding) => {
        if (!interfered && target !== file) {
          interfered = true
          await realFs.writeFile(file, JSON.stringify({ effort: 'max' }), 'utf8')
        }
        await realFs.writeFile(target, data, encoding)
      },
    })

    await updateSettingsFile(file, { ours: 1 }, { fs, backup: false })

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ effort: 'max', ours: 1 })
  })

  it('gives up after a bounded number of conflicting writes, leaving the other writer\'s file', async () => {
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, ORIGINAL)
    let round = 0
    const fs = fsWith({
      writeFile: async (target, data, encoding) => {
        if (target !== file) {
          round += 1
          await realFs.writeFile(file, JSON.stringify({ round }), 'utf8')
        }
        await realFs.writeFile(target, data, encoding)
      },
    })

    await expect(updateSettingsFile(file, { ours: 1 }, { fs, backup: false })).rejects.toThrow(/changed/i)

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ round })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('retries when the check before the rename cannot read the file for a moment', async () => {
    // Another process holds the file (EBUSY) just as the content is compared before the rename.
    // A later read succeeds, so the write still lands.
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, ORIGINAL)
    let reads = 0
    const fs = fsWith({
      readFile: (target, encoding) => {
        reads += 1
        return reads === 2 ? Promise.reject(codedError('EBUSY')) : realFs.readFile(target, encoding)
      },
    })

    await transformSettingsFile(file, (existing) => ({ ...existing, ours: 1 }), { fs, backup: false })

    expect(reads).toBeGreaterThan(2)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...JSON.parse(ORIGINAL), ours: 1 })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('refuses in its own words when the file stays unreadable after the first read', async () => {
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await writeFile(file, ORIGINAL)
    let reads = 0
    const fs = fsWith({
      readFile: (target, encoding) => {
        reads += 1
        return reads === 1 ? realFs.readFile(target, encoding) : Promise.reject(codedError('EBUSY'))
      },
    })

    await expect(
      transformSettingsFile(file, (existing) => ({ ...existing, ours: 1 }), { fs, backup: false }),
    ).rejects.toThrow(/Cannot read existing settings .*\(EBUSY\); refusing to write/)

    expect(await readFile(file, 'utf8')).toBe(ORIGINAL)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('backs up the existing file once before the first change and never overwrites the backup', async () => {
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    const backup = `${file}${SETTINGS_BACKUP_SUFFIX}`
    await writeFile(file, ORIGINAL)

    await updateSettingsFile(file, { a: 1 })
    expect(await readFile(backup, 'utf8')).toBe(ORIGINAL)

    await updateSettingsFile(file, { b: 2 })
    expect(await readFile(backup, 'utf8')).toBe(ORIGINAL)
  })

  it('keeps a backup that already exists', async () => {
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    const backup = `${file}${SETTINGS_BACKUP_SUFFIX}`
    await writeFile(file, ORIGINAL)
    await writeFile(backup, 'the very first one')

    await updateSettingsFile(file, { a: 1 })

    expect(await readFile(backup, 'utf8')).toBe('the very first one')
  })

  it('makes no backup for a file that did not exist', async () => {
    // A brand-new machine has no settings.json (ENOENT): that still starts as empty settings.
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    await updateSettingsFile(file, { a: 1 })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('neither writes nor backs up when the transform changes nothing', async () => {
    const dir = await tempDir('cs-writer-')
    const file = path.join(dir, 'settings.json')
    const formatted = `${JSON.stringify({ a: 1 }, null, 2)}\n`
    await writeFile(file, formatted)
    let writes = 0
    const fs = fsWith({
      writeFile: (target, data, encoding) => {
        writes += 1
        return realFs.writeFile(target, data, encoding)
      },
    })

    await transformSettingsFile(file, (existing) => existing, { fs })

    expect(writes).toBe(0)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})
