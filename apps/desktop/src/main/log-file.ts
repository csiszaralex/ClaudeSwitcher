import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { formatWithOptions } from 'node:util'

/** The folder under `userData` that holds the log. */
const LOG_DIR_NAME = 'logs'
/** The current log file. */
const LOG_FILE_NAME = 'claudeswitcher.log'
/** The previous log file: the current one moves here when it is full, replacing an older one. */
export const OLD_LOG_FILE_NAME = 'claudeswitcher.old.log'
/** A write that would take the current file over this size starts a new file first. */
export const LOG_MAX_BYTES = 1024 * 1024

/** The log folder inside a `userData` directory. */
export function logDir(userData: string): string {
  return path.join(userData, LOG_DIR_NAME)
}

/** The current log file inside a `userData` directory. */
export function logFilePath(userData: string): string {
  return path.join(logDir(userData), LOG_FILE_NAME)
}

/**
 * Creates the log folder and the (empty) file if they are missing, and returns the file's path, so
 * opening the log always finds something. Throws if the disk refuses: the caller reports it.
 */
export function ensureLogFile(userData: string): string {
  mkdirSync(logDir(userData), { recursive: true })
  const file = logFilePath(userData)
  appendFileSync(file, '')
  return file
}

type ConsoleMethod = (...args: unknown[]) => void

/** The three `console` methods the log wraps; `console` itself fits. */
export interface ConsoleTarget {
  log: ConsoleMethod
  warn: ConsoleMethod
  error: ConsoleMethod
}

const LEVELS = ['log', 'warn', 'error'] as const

/**
 * Wraps `target.log`, `target.warn` and `target.error` so every call also appends one line to the
 * log file in `userData`, after calling the original method (so `pnpm dev` prints what it always
 * did). A line is the ISO time, the pid, the level and the arguments formatted the way `console`
 * formats them, so an `Error` keeps its stack. The pid tells the `--quit` helper apart from the app.
 *
 * Writes are synchronous: the volume is a few lines a minute, and a line written while the process
 * is dying (`uncaughtException`) must be on the disk before it ends. A write error never reaches
 * the caller: the first one turns the file log off for the run and is reported once through the
 * original `console.error` (never through the wrapped one, which would write again).
 */
export function installFileLog(deps: {
  userData: string
  target: ConsoleTarget
  now: () => Date
  pid: number
  /** Overridable for tests; `LOG_MAX_BYTES` otherwise. */
  maxBytes?: number
}): void {
  const { userData, target, now, pid } = deps
  const maxBytes = deps.maxBytes ?? LOG_MAX_BYTES
  const file = logFilePath(userData)
  const oldFile = path.join(logDir(userData), OLD_LOG_FILE_NAME)
  // Bound before wrapping: `target.error` is replaced below.
  const originals: Record<(typeof LEVELS)[number], ConsoleMethod> = {
    log: target.log.bind(target),
    warn: target.warn.bind(target),
    error: target.error.bind(target),
  }
  let enabled = true

  /** The file's size now, read each time: the `--quit` helper writes to the same file. */
  const currentSize = (): number => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  }

  const write = (level: (typeof LEVELS)[number], args: unknown[]): void => {
    if (!enabled) return
    try {
      const line = `${now().toISOString()} ${String(pid)} ${level.toUpperCase()} ${formatWithOptions({ colors: false }, ...args)}\n`
      mkdirSync(logDir(userData), { recursive: true })
      const size = currentSize()
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, oldFile)
      appendFileSync(file, line)
    } catch (error) {
      enabled = false
      originals.error('[log] writing the log file failed; the file log is off for this run', error)
    }
  }

  for (const level of LEVELS) {
    target[level] = (...args: unknown[]): void => {
      originals[level](...args)
      write(level, args)
    }
  }
}
