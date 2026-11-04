/**
 * Test support shared by every package: temp directories, the measured hook payloads, a fake
 * process probe and a fake Claude config directory. Only tests import it, through the dev-only
 * `@claudeswitcher/core/testing` export, which points at this source file: the build tsconfig
 * excludes it, so it is not in `dist/` and no runtime bundle reaches it.
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'
import { parsePermissionRequest, type PermissionRequestInfo } from './decision.js'
import { isRecord } from './guards.js'
import type { ProcessProbe } from './liveness.js'
import { sessionsDir } from './paths.js'

/**
 * A fresh directory in the system temp folder, removed when the running test finishes. Call it from
 * a test or from `beforeEach`, because `onTestFinished` ties the clean-up to the running test; not
 * from `beforeAll`.
 */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** The hook bodies recorded live by the permission spike, keyed by name. */
const HOOK_PAYLOADS: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/hook-payloads.json', import.meta.url), 'utf8'),
)

/** One recorded hook body. Throws for a name the fixture file lacks, so a typo fails loudly. */
export function hookPayload(name: string): Record<string, unknown> {
  const value = isRecord(HOOK_PAYLOADS) && Object.hasOwn(HOOK_PAYLOADS, name) ? HOOK_PAYLOADS[name] : undefined
  if (value === undefined) throw new Error(`unknown fixture: ${name}`)
  if (!isRecord(value)) throw new Error(`fixture ${name} is not an object`)
  return value
}

/** A recorded PermissionRequest body, parsed. Throws if the fixture exists but does not parse. */
export function parsedPayload(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(hookPayload(name))
  if (info === undefined) throw new Error(`fixture ${name} did not parse`)
  return info
}

/**
 * A process probe that answers without a process snapshot. By default every pid is alive, runs the
 * `Code` image and has an unknown start time; `overrides` replaces single answers.
 */
export function fakeProbe(overrides: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    isAlive: () => true,
    imageName: () => 'Code',
    startedAtMs: () => undefined,
    refresh: () => Promise.resolve(),
    ...overrides,
  }
}

/** Writes the session record the scanner and daemon tests start from: pid 100, session `sid-100`. */
export async function writeSessionRecord(claudeDir: string): Promise<void> {
  await mkdir(sessionsDir(claudeDir), { recursive: true })
  await writeFile(
    path.join(sessionsDir(claudeDir), '100.json'),
    JSON.stringify({
      pid: 100, sessionId: 'sid-100', cwd: 'p:\\proj\\alpha',
      startedAt: 1, procStart: 'ps-100', name: 'alpha-01',
    }),
  )
}
