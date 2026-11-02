import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@claudeswitcher/core'
import { parseInstanceRecord, type InstanceRecord } from './instance.js'

/** The record's file name in `userData`. */
export const INSTANCE_FILE = 'instance.json'

function recordPath(dir: string): string {
  return path.join(dir, INSTANCE_FILE)
}

/** Written atomically, so a reader never sees half a record. */
export async function writeInstanceRecord(dir: string, record: InstanceRecord): Promise<void> {
  await writeFileAtomic(recordPath(dir), JSON.stringify(record))
}

/** The record, or `undefined` if the file is missing, unreadable or not a valid record. Never throws. */
export async function readInstanceRecord(dir: string): Promise<InstanceRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recordPath(dir), 'utf8'))
    return parseInstanceRecord(parsed)
  } catch {
    return undefined
  }
}

/**
 * Removes the record only if it still names `pid`. A file naming another pid belongs to a newer
 * instance that took over meanwhile, and stays. Never throws; a leftover record is harmless, since the
 * next primary overwrites it, and a build that finds the lock free never reads it.
 */
export async function removeInstanceRecord(dir: string, pid: number): Promise<void> {
  const record = await readInstanceRecord(dir)
  if (record?.pid !== pid) return
  try {
    await rm(recordPath(dir), { force: true })
  } catch (error) {
    console.error('[claudeswitcher] could not remove the instance record', error)
  }
}
