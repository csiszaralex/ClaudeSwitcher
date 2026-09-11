#!/usr/bin/env node
import { renderStatusLine } from './render.js'

/**
 * A Claude Code stdin-en adja a session JSON-t, és a stdoutot rendereli a
 * statusLine-ban. Mellékhatásként a rate limiteket elküldjük a daemonnak.
 * A POST soha nem blokkolhatja a sor kiírását: rövid timeout, hiba elnyelve.
 */
async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)

  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      input = parsed as Record<string, unknown>
    }
  } catch {
    // Nincs értelmes bemenet — üres sort adunk, de nem hibázunk.
  }

  process.stdout.write(renderStatusLine(input))

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
