import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from './guards.js'

/**
 * The few file operations this module uses. Replaceable for tests: a busy file (EBUSY), a read of
 * a half-truncated file or another process writing meanwhile cannot be produced deterministically
 * on a real file system.
 */
export interface SettingsFs {
  readFile(file: string, encoding: 'utf8'): Promise<string>
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(file: string): Promise<void>
  copyFile(from: string, to: string, mode: number): Promise<void>
}

const nodeFs: SettingsFs = { readFile, writeFile, rename, unlink, copyFile }

export interface SettingsWriteOptions {
  /** The real `node:fs/promises` by default. */
  fs?: SettingsFs
  /**
   * A one-time backup of the existing file before the first write that changes it. On by default;
   * our own config file does not need one.
   */
  backup?: boolean
}

/** The backup sits beside the target file, with this suffix. */
export const SETTINGS_BACKUP_SUFFIX = '.claudeswitcher-backup'

/** How many times an existing but empty file is re-read before the write is refused. */
const EMPTY_READ_RETRIES = 3
const EMPTY_READ_DELAY_MS = 50
/** How many times the whole read, transform, write cycle is retried when someone else wrote meanwhile. */
const CONFLICT_ATTEMPTS = 3

/** The Node file system error code (`ENOENT`, `EBUSY`…), if any. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** True when the error means the file does not exist. Every other error is a real error. */
export function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

/**
 * True if the path is missing: the file itself (`ENOENT`), or a parent that is a file, not a
 * directory (`ENOTDIR`). For optional files, where both mean "not there".
 */
export function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Recursive merge. Objects are merged deeply, arrays and scalars are replaced. Replacing arrays is
 * deliberate: the hook config must be rewritten idempotently, not duplicated on every install.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    // Assigning `__proto__` would call the prototype setter instead of creating a data key, and the
    // payload would vanish silently. It is not a real Claude Code settings key, but silent data
    // loss is not left in the code.
    if (key === '__proto__') continue
    const current = out[key]
    out[key] =
      isRecord(value) && isRecord(current)
        ? mergeSettings(current, value)
        : value
  }
  return out
}

/**
 * One queue per target file.
 *
 * Without it, two concurrent calls on the same file would leave interleaved, unreadable JSON
 * behind (exactly the disaster this module exists to prevent), and the second read would miss the
 * first write, so one patch would be lost even if the file stayed intact.
 *
 * The map holds only as many entries as there are distinct files written through it (the user's
 * settings.json and the desktop app's config file), so it does not grow without bound.
 */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * An atomic, queued, parse-safe read, transform and write. `transform` gets the object read from
 * the file and returns the one to write. It runs again on a conflict, so it must be pure and
 * repeatable.
 *
 * It exists next to the merge patch because removing the integration deletes keys, which a merge
 * patch cannot express. It shares its queue with `updateSettingsFile`, so the two cannot drop each
 * other's writes to the same file.
 */
export function transformSettingsFile(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
  options: SettingsWriteOptions = {},
): Promise<void> {
  const key = path.resolve(filePath)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  // The next caller must wait for the file operation to *finish*, not to succeed. That is why the
  // chain goes on after an error.
  const next = previous.then(
    () => writeTransformed(filePath, transform, options),
    () => writeTransformed(filePath, transform, options),
  )
  writeQueues.set(key, next.catch(() => undefined))
  return next
}

export function updateSettingsFile(
  filePath: string,
  patch: Record<string, unknown>,
  options: SettingsWriteOptions = {},
): Promise<void> {
  return transformSettingsFile(filePath, (existing) => mergeSettings(existing, patch), options)
}

/**
 * Atomic write: a uniquely named temporary file, then a rename. The target holds either the old or
 * the new content, never a partial one.
 *
 * `beforeRename` may decide at the last moment before the rename not to write after all: then the
 * temp file is removed, the target is untouched, and the result is `false`.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: { fs?: SettingsFs; beforeRename?: () => Promise<boolean> } = {},
): Promise<boolean> {
  const fs = options.fs ?? nodeFs
  // Unique per process AND per call: the pid alone is not enough.
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, data, 'utf8')
    if (options.beforeRename !== undefined && !(await options.beforeRename())) {
      await fs.unlink(temp).catch(() => undefined)
      return false
    }
    await fs.rename(temp, filePath)
    return true
  } catch (error) {
    // Leave no debris in the target directory. The target file is untouched, which is what matters.
    await fs.unlink(temp).catch(() => undefined)
    throw error
  }
}

/** The raw content, or `undefined` when the file does not exist. */
async function readRaw(fs: SettingsFs, filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

interface Snapshot {
  /** The raw content, or `undefined` when the file did not exist. */
  raw: string | undefined
  existing: Record<string, unknown>
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads the file, and treats it as empty settings only when it really does not exist (ENOENT).
 *
 * Every other read error (EBUSY, EPERM, EACCES, EMFILE…) throws: they used to become `{}`, and the
 * install overwrote the user's whole settings with only our keys. An existing but empty file is
 * typically the moment between another writer's truncate and write, so it is re-read after short
 * pauses. If it stays empty, the write is refused rather than treated as `{}`.
 */
async function readSnapshot(fs: SettingsFs, filePath: string): Promise<Snapshot> {
  for (let retry = 0; ; retry++) {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) return { raw: undefined, existing: {} }
      throw new Error(
        `Cannot read existing settings at ${filePath} (${errorCode(error) ?? 'unknown error'}); refusing to write`,
        { cause: error },
      )
    }
    if (raw.trim() === '') {
      if (retry < EMPTY_READ_RETRIES) {
        await delay(EMPTY_READ_DELAY_MS)
        continue
      }
      throw new Error(`Settings at ${filePath} exists but is empty; refusing to write`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`Cannot parse existing settings at ${filePath}; refusing to write`, { cause })
    }
    if (!isRecord(parsed)) {
      throw new Error(`Settings at ${filePath} is not a JSON object; refusing to write`)
    }
    return { raw, existing: parsed }
  }
}

/**
 * A one-time backup. Thanks to `COPYFILE_EXCL` it never overwrites an existing backup, and the
 * existence check cannot race the copy. If the backup cannot be made, nothing is written.
 */
async function ensureBackup(fs: SettingsFs, filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}${SETTINGS_BACKUP_SUFFIX}`, constants.COPYFILE_EXCL)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return
    throw new Error(
      `Cannot back up settings at ${filePath} (${errorCode(error) ?? 'unknown error'}); refusing to write`,
      { cause: error },
    )
  }
}

/**
 * For an existing file that does not parse, is not an object, cannot be read or stays empty, it
 * throws, and it does NOT call the transform or write. Better to change nothing than to lose the
 * user's settings.
 *
 * Optimistic concurrency: if the file's content changed between the read and the rename, the temp
 * file is dropped and the whole cycle is repeated on the fresh content, a bounded number of times.
 * The content is compared, not the mtime and the size: a write that leaves a file of the same size
 * within one mtime tick does not show in those. A lock file would not help, because Claude Code
 * and the editors do not know it. The gap between the last comparison and the rename remains: only
 * a shared lock could close it.
 */
async function writeTransformed(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
  options: SettingsWriteOptions,
): Promise<void> {
  const fs = options.fs ?? nodeFs
  for (let attempt = 1; attempt <= CONFLICT_ATTEMPTS; attempt++) {
    const snapshot = await readSnapshot(fs, filePath)
    const data = JSON.stringify(transform(snapshot.existing), null, 2) + '\n'
    // Unchanged content is not written, so it needs no backup either.
    if (data === snapshot.raw) return
    if (snapshot.raw !== undefined && options.backup !== false) await ensureBackup(fs, filePath)
    const written = await writeFileAtomic(filePath, data, {
      fs,
      beforeRename: async () => (await readRaw(fs, filePath)) === snapshot.raw,
    })
    if (written) return
  }
  throw new Error(
    `Settings at ${filePath} kept being changed by another writer; gave up after ${String(CONFLICT_ATTEMPTS)} attempts`,
  )
}
