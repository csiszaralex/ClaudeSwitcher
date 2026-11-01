import path from 'node:path'
import { isRecord, nonEmptyString } from '@claudeswitcher/core'
import { STOP_TIMEOUT_MS } from './shutdown.js'

/**
 * Which build a running instance is. `dev` and `start` both run `electron .` in `apps/desktop`,
 * so their `execPath` and `appPath` are equal: only `renderer` tells them apart.
 */
export interface BuildIdentity {
  /** `process.execPath`: the packaged exe, or `electron.exe` in a repo build. */
  execPath: string
  /** `app.getAppPath()`: `resources\app.asar` when packaged, `apps\desktop` in a repo build. */
  appPath: string
  /** `dev-server` when `ELECTRON_RENDERER_URL` is set (`electron-vite dev`), otherwise `file`. */
  renderer: 'dev-server' | 'file'
  /** `app.getVersion()`. Only for the text, never for the comparison. */
  version: string
  packaged: boolean
}

/** How this process was launched: the app itself, or a helper the installer runs. */
export type LaunchMode = 'normal' | 'quit' | 'uninstall'

/**
 * Exit codes of the `--quit` and `--uninstall` launch modes. The NSIS macros rely on them:
 * - `ok` (0): nothing was running, or the running app quit (and, for `--uninstall`, the autostart
 *   entry and the Claude Code integration were removed);
 * - `notClosed` (1): the running app could not be closed;
 * - `integrationFailed` (2): `--uninstall` only, removing the Claude Code integration failed.
 */
export const LAUNCH_EXIT_CODE: { readonly ok: 0; readonly notClosed: 1; readonly integrationFailed: 2 } = {
  ok: 0,
  notClosed: 1,
  integrationFailed: 2,
}

/**
 * How long a hand-over waits for the running app to exit. The app spends up to `STOP_TIMEOUT_MS`
 * stopping its daemon; the 8 s on top cover starting the `--quit` helper (an Electron process,
 * which takes seconds on a slow machine) and Electron's own teardown after the daemon stopped.
 */
export const HANDOVER_TIMEOUT_MS = STOP_TIMEOUT_MS + 8000

/** `--uninstall` wins over `--quit`: it does everything `--quit` does, and more. */
export function launchMode(argv: readonly string[]): LaunchMode {
  if (argv.includes('--uninstall')) return 'uninstall'
  if (argv.includes('--quit')) return 'quit'
  return 'normal'
}

/** A Windows path compared case-insensitively, with either slash and no trailing separator. */
function comparablePath(value: string): string {
  return path.win32.normalize(value).replace(/\\+$/, '').toLowerCase()
}

/** Same executable, same app path, same renderer source. The version does not count. */
export function sameBuild(a: BuildIdentity, b: BuildIdentity): boolean {
  return (
    comparablePath(a.execPath) === comparablePath(b.execPath) &&
    comparablePath(a.appPath) === comparablePath(b.appPath) &&
    a.renderer === b.renderer
  )
}

/** The build's name in the hand-over dialog. */
export function describeBuild(build: BuildIdentity): string {
  if (build.packaged) return `telepített, ${build.version}`
  return build.renderer === 'dev-server' ? 'repóból, dev' : 'repóból, start'
}

/** What a second instance tells the primary through `requestSingleInstanceLock`'s `additionalData`. */
export type InstanceMessage = { kind: 'show'; build: BuildIdentity } | { kind: 'quit' }

function parseBuild(raw: unknown): BuildIdentity | undefined {
  if (!isRecord(raw)) return undefined
  const execPath = nonEmptyString(raw['execPath'])
  const appPath = nonEmptyString(raw['appPath'])
  const renderer = raw['renderer']
  const version = raw['version']
  const packaged = raw['packaged']
  if (execPath === undefined || appPath === undefined) return undefined
  if (renderer !== 'dev-server' && renderer !== 'file') return undefined
  if (typeof version !== 'string' || typeof packaged !== 'boolean') return undefined
  return { execPath, appPath, renderer, version, packaged }
}

/** The message, or `undefined` for anything else (an older build sends no `additionalData`). */
export function parseInstanceMessage(raw: unknown): InstanceMessage | undefined {
  if (!isRecord(raw)) return undefined
  if (raw['kind'] === 'quit') return { kind: 'quit' }
  if (raw['kind'] !== 'show') return undefined
  const build = parseBuild(raw['build'])
  return build === undefined ? undefined : { kind: 'show', build }
}

/**
 * What the primary does with a second instance's message: `quit` for the `--quit` helper; `show`
 * the overlay for the same build, or for an older build that sends no message; `ignore` a
 * different build, which shows its own hand-over dialog.
 */
export function instanceAction(message: InstanceMessage | undefined, own: BuildIdentity): 'quit' | 'show' | 'ignore' {
  if (message === undefined) return 'show'
  if (message.kind === 'quit') return 'quit'
  return sameBuild(message.build, own) ? 'show' : 'ignore'
}

/** What the primary writes to `instance.json`: who holds the lock, so another build can wait for it. */
export interface InstanceRecord {
  pid: number
  build: BuildIdentity
}

export function parseInstanceRecord(raw: unknown): InstanceRecord | undefined {
  if (!isRecord(raw)) return undefined
  const pid = raw['pid']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  const build = parseBuild(raw['build'])
  return build === undefined ? undefined : { pid, build }
}
