#!/usr/bin/env node
// Command hook: appends the payload it gets on stdin to the spike log and prints NOTHING, so it
// never makes a decision; exit code 0 lets the normal flow continue.
//
// It sits next to the HTTP hook to tell two failures apart: if the HTTP hook stays silent but this
// one fires, the event does run, only `type: "http"` is not supported for it.
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
    // A log failure must not block the session.
  }
  process.exit(0)
})
