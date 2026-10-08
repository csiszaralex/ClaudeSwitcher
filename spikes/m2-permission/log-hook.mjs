#!/usr/bin/env node
// Parancs-típusú hook: a stdin-en kapott payloadot hozzáfűzi a spike naplóhoz, és SEMMIT nem
// ír ki — így soha nem hoz döntést, a 0-s kilépés a normál folyamatot engedi tovább.
//
// Azért van a HTTP hook mellett, hogy két hibát szét lehessen választani: ha a HTTP hook nem
// jelez, de ez igen, akkor az esemény lefut, csak a `type: "http"` nem támogatott rá.
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const event = process.argv[2] ?? 'unknown'
const workspace = process.env.CS_SPIKE_DIR ?? 'P:/08_Apps/cs-spike'

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8')
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    body = { _unparsed: raw }
  }
  try {
    appendFileSync(
      path.join(workspace, 'spike-log.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), kind: 'command-hook', event, body })}\n`,
      'utf8',
    )
  } catch {
    // A napló hibája nem akaszthatja meg a sessiont.
  }
  process.exit(0)
})
