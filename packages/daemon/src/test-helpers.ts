import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

/**
 * Saját könyvtár a rendszer temp mappájában, amit a futó teszt végén eltakarítunk. A tesztből
 * vagy a `beforeEach`-ből hívható, mert az `onTestFinished` a futó teszthez köti a takarítást;
 * a `beforeAll`-ból nem. Csak tesztkód használja: a build tsconfig kizárja.
 */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Addig olvas, amíg a lista nem üres, és azt adja vissza. Időtúllépésnél dob. */
export async function waitFor<T>(read: () => T[] | Promise<T[]>, timeoutMs = 2000): Promise<T[]> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value.length > 0) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
