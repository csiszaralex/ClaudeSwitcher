/** Ennyit várunk kilépéskor a daemon leállására. Bőven elég az üres 200-ak kiküldésére. */
const STOP_TIMEOUT_MS = 2000

/**
 * A daemon leállítása legfeljebb `timeoutMs` ideig. Igazat ad, ha a leállás időben lezárult,
 * hamisat, ha az idő lejárt vagy a leállás hibát dobott. A kilépés egyik esetben sem akadhat
 * meg: a tartott kérések kapcsolatai a processzel úgyis elhalnak, és azt a Claude Code mérten
 * „nincs döntés"-nek veszi (spec §8).
 */
export async function stopWithin(stop: () => Promise<void>, timeoutMs: number = STOP_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false)
    }, timeoutMs)
  })
  const stopped = stop().then(
    () => true,
    (error: unknown) => {
      console.error('[claudeswitcher] daemon stop failed', error)
      return false
    },
  )
  try {
    return await Promise.race([stopped, expired])
  } finally {
    clearTimeout(timer)
  }
}
