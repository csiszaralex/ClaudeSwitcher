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
