import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNotFoundError, writeFileAtomic } from '@claudeswitcher/core'
import { createToken, isToken } from '@claudeswitcher/daemon'

/**
 * A persistent daemon token. The installed hooks get it from the `env` block of settings.json, so
 * it has to stay the same across app restarts, otherwise every restart would make the install
 * stale.
 *
 * A new token is made in only two cases: if the file does not exist (ENOENT), or if its content is
 * not a valid token. Every other read error throws, and the startup error dialog shows it: after a
 * token silently replaced because of a transient error, every installed hook would get a 401.
 */
export async function loadOrCreateToken(dir: string): Promise<string> {
  const file = path.join(dir, 'daemon-token')
  let existing: string | undefined
  try {
    existing = (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
  if (existing !== undefined && isToken(existing)) return existing

  const token = createToken()
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(file, token)
  return token
}
