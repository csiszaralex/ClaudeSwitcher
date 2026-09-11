#!/usr/bin/env node
import { renderStatusLine } from './render.js'

/** Ennyit várunk a stdin lezárására, mielőtt üres bemenettel renderelünk. */
const STDIN_TIMEOUT_MS = 500

/**
 * Kiolvassa a streamet, de feladja `timeoutMs` után.
 *
 * Enélkül egy le nem zárt stdin örökre megállítaná a ciklust, és a statusLine
 * **semmit** nem írna ki — pont az a veszteség, ami ellen ez a csomag létezik.
 * A streamet paraméterként veszi át, mert így a feladási ág tesztelhető anélkül,
 * hogy a processz stdinjével kellene trükközni.
 */
export async function readAllOrGiveUp(
  stream: AsyncIterable<Buffer> & { destroy(): void },
  timeoutMs: number = STDIN_TIMEOUT_MS,
): Promise<string> {
  const read = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  })().catch(() => '')

  let timer: NodeJS.Timeout | undefined
  const giveUp = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      // A stream lezárása nélkül a processz a kiírás után is életben maradna.
      stream.destroy()
      resolve('')
    }, timeoutMs)
    timer.unref()
  })

  try {
    return await Promise.race([read, giveUp])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * A Claude Code stdin-en adja a session JSON-t, és a stdoutot rendereli a
 * statusLine-ban. Mellékhatásként a rate limiteket elküldjük a daemonnak.
 * A POST soha nem blokkolhatja a sor kiírását: rövid timeout, hiba elnyelve.
 */
async function main(): Promise<void> {
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readAllOrGiveUp(process.stdin))
    if (typeof parsed === 'object' && parsed !== null) {
      input = parsed as Record<string, unknown>
    }
  } catch {
    // Nincs értelmes bemenet — üres sort adunk, de nem hibázunk.
  }

  // Védőháló a renderelés köré is. Ma egyetlen bemenet sem dobat vele, de egy
  // későbbi módosítás elronthatná, és egy elkapatlan kivétel itt nulla kimenetet
  // ÉS nem-nulla kilépési kódot jelentene — a legrosszabb kimenet ebben a
  // scriptben, mert a felhasználó saját footerét rontaná el.
  let line = ''
  try {
    line = renderStatusLine(input)
  } catch {
    line = ''
  }
  process.stdout.write(line)

  const port = process.env.CLAUDESWITCHER_PORT
  const token = process.env.CLAUDESWITCHER_TOKEN
  if (port !== undefined && token !== undefined && input.rate_limits !== undefined) {
    try {
      await fetch(`http://127.0.0.1:${port}/statusline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ rate_limits: input.rate_limits }),
        signal: AbortSignal.timeout(1000),
      })
    } catch {
      // A daemon nem fut. A statusLine attól még helyes.
    }
  }
}

await main()
