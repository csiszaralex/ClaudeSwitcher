import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InstanceRecord } from './instance.js'
import { INSTANCE_FILE, readInstanceRecord, removeInstanceRecord, writeInstanceRecord } from './instance-file.js'
import { tempDir } from './test-helpers.js'
import { waitForExit } from './wait-for-exit.js'

const record: InstanceRecord = {
  pid: 4242,
  build: {
    execPath: 'P:\\proj\\alpha\\node_modules\\electron\\dist\\electron.exe',
    appPath: 'P:\\proj\\alpha\\apps\\desktop',
    renderer: 'dev-server',
    version: '0.0.0',
    packaged: false,
  },
}

describe('instance record file', () => {
  it('round-trips the record', async () => {
    const dir = await tempDir('cs-instance-')
    await writeInstanceRecord(dir, record)
    await expect(readInstanceRecord(dir)).resolves.toEqual(record)
  })

  it('gives undefined for a missing file and does not throw', async () => {
    const dir = await tempDir('cs-instance-')
    await expect(readInstanceRecord(dir)).resolves.toBeUndefined()
  })

  it('gives undefined for a broken file and does not throw', async () => {
    const dir = await tempDir('cs-instance-')
    await writeFile(path.join(dir, INSTANCE_FILE), '{"pid": 42', 'utf8')
    await expect(readInstanceRecord(dir)).resolves.toBeUndefined()
    await writeFile(path.join(dir, INSTANCE_FILE), '{"pid": 0}', 'utf8')
    await expect(readInstanceRecord(dir)).resolves.toBeUndefined()
  })

  it('removes the file that names this pid', async () => {
    const dir = await tempDir('cs-instance-')
    await writeInstanceRecord(dir, record)
    await removeInstanceRecord(dir, record.pid)
    await expect(readInstanceRecord(dir)).resolves.toBeUndefined()
  })

  it('leaves a file that names another pid: it belongs to a newer instance', async () => {
    const dir = await tempDir('cs-instance-')
    await writeInstanceRecord(dir, record)
    await removeInstanceRecord(dir, record.pid + 1)
    await expect(readInstanceRecord(dir)).resolves.toEqual(record)
    // Untouched, not rewritten.
    expect(JSON.parse(await readFile(path.join(dir, INSTANCE_FILE), 'utf8'))).toEqual(record)
  })

  it('removing a missing file does not throw', async () => {
    const dir = await tempDir('cs-instance-')
    await expect(removeInstanceRecord(dir, record.pid)).resolves.toBeUndefined()
  })

  it('a record from a dead older instance does not block', async () => {
    const dir = await tempDir('cs-instance-')
    await writeInstanceRecord(dir, record)
    const stale = await readInstanceRecord(dir)
    expect(stale).toBeDefined()
    const started = Date.now()
    // The pid is dead: waiting on it resolves at once, without a single poll interval.
    await expect(waitForExit(stale?.pid ?? 0, 60_000, () => false)).resolves.toBe(true)
    expect(Date.now() - started).toBeLessThan(100)
  })
})
