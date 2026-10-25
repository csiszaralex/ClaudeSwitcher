/** Legfeljebb ennyi renderer-újratöltés `RELOAD_WINDOW_MS` alatt. */
export const RELOAD_LIMIT = 3
export const RELOAD_WINDOW_MS = 60_000

export interface ReloadLimiterOptions {
  limit?: number | undefined
  windowMs?: number | undefined
  /** Az óra, hogy a csúszó ablak tesztelhető legyen. */
  now?: (() => number) | undefined
}

/**
 * Egy csúszó ablakos korlát az overlay renderer újratöltésére. Igazat ad, ha az újratöltés még
 * belefér, és ilyenkor fel is jegyzi.
 *
 * Egy betöltéskor mindig összeomló renderer (például OOM egy hatalmas állapoton) korlát nélkül
 * szoros összeomlás és újratöltés ciklusba esne, ami égeti a CPU-t és teleírja a naplót. A
 * megtagadott kísérlet nem számít bele az ablakba, így a korlát az utolsó engedélyezett
 * újratöltések után legkésőbb `windowMs` múlva újra enged (az `index.ts` ilyenkor az overlay
 * következő megnyitásakor próbálja újra).
 */
export function createReloadLimiter(options: ReloadLimiterOptions = {}): () => boolean {
  const limit = options.limit ?? RELOAD_LIMIT
  const windowMs = options.windowMs ?? RELOAD_WINDOW_MS
  const now = options.now ?? (() => Date.now())
  let reloads: number[] = []
  return () => {
    const at = now()
    reloads = reloads.filter((t) => at - t < windowMs)
    if (reloads.length >= limit) return false
    reloads.push(at)
    return true
  }
}
