import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNotFoundError, writeFileAtomic } from '@claudeswitcher/core'

const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/**
 * Tartós daemon-token. A telepített hookok a settings.json `env` blokkjából
 * kapják, tehát az app újraindításai között azonosnak kell maradnia, különben minden
 * újraindítás elavulttá tenné a telepítést.
 *
 * Új tokent csak két esetben készítünk: ha a fájl nincs meg (ENOENT), vagy ha a tartalma nem
 * érvényes token. Minden más olvasási hiba dob, és az indulási hibadialógus mutatja: egy
 * átmeneti hiba miatt csendben lecserélt token után minden telepített hook 401-et kapna.
 */
export async function loadOrCreateToken(dir: string): Promise<string> {
  const file = path.join(dir, 'daemon-token')
  let existing: string | undefined
  try {
    existing = (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
  if (existing !== undefined && TOKEN_PATTERN.test(existing)) return existing

  const token = randomBytes(16).toString('hex')
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(file, token)
  return token
}
