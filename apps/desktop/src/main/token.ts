import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/**
 * Tartós daemon-token. A telepített hookok és a statusLine a settings.json `env` blokkjából
 * kapják, tehát az app újraindításai között azonosnak kell maradnia — különben minden
 * újraindítás elavulttá tenné a telepítést. Egy nem érvényes tokent tartalmazó fájlt
 * lecserélünk, nem hibázunk rajta.
 */
export async function loadOrCreateToken(dir: string): Promise<string> {
  const file = path.join(dir, 'daemon-token')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (TOKEN_PATTERN.test(existing)) return existing
  } catch {
    // Még nincs token — létrehozzuk.
  }

  const token = randomBytes(16).toString('hex')
  await mkdir(dir, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, token, 'utf8')
  await rename(temp, file)
  return token
}
