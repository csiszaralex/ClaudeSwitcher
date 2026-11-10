#!/usr/bin/env node
// Permission spike: a measuring server for Claude Code's hooks.
//
// Not product code. Its only purpose is to settle the design's open questions BY MEASUREMENT: does
// PermissionRequest run in the VS Code extension, what happens when we hold the response, and what
// comes in the payload. So it logs everything RAW and answers PermissionRequest in a controllable
// way.
//
// Usage:
//   node server.mjs                     start the server (in the foreground, Ctrl+C stops it)
//   node server.mjs mode pass           PermissionRequest: empty 200, no decision
//   node server.mjs mode hold 60        PermissionRequest: hold for 60 s, then empty 200
//   node server.mjs mode allow          PermissionRequest: allow
//   node server.mjs mode deny           PermissionRequest: deny
//   node server.mjs mode allow-after 30 PermissionRequest: hold for 30 s, then allow
//   node server.mjs summary             summarize the log
//
// Binds only to 127.0.0.1, runs without dependencies.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PORT = Number(process.env.CS_SPIKE_PORT ?? 47899)
const WORKSPACE = process.env.CS_SPIKE_DIR ?? 'P:/08_Apps/cs-spike'
const LOG = path.join(WORKSPACE, 'spike-log.jsonl')
const MODE_FILE = path.join(WORKSPACE, 'mode.json')

const DEFAULT_MODE = { mode: 'pass', seconds: 0 }
const MODES = new Set(['pass', 'hold', 'allow', 'deny', 'allow-after', 'allow-rule', 'custom'])

// The `custom` mode builds the response from `respond.mjs` in the spike folder, loaded fresh for
// every request. So a new measurement only needs that file rewritten, not a server restart.
const RESPOND_FILE = path.join(WORKSPACE, 'respond.mjs')

function readMode() {
  try {
    const parsed = JSON.parse(readFileSync(MODE_FILE, 'utf8'))
    return MODES.has(parsed.mode) ? parsed : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

function log(entry) {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
}

const time = () => new Date().toLocaleTimeString('hu-HU')

function short(body) {
  const parts = []
  if (body.tool_name) parts.push(`tool=${body.tool_name}`)
  if (body.notification_type) parts.push(`type=${body.notification_type}`)
  if (body.agent_id) parts.push(`agent_id=${body.agent_id}`)
  if (body.agent_type) parts.push(`agent_type=${body.agent_type}`)
  if (body.session_id) parts.push(`sid=${String(body.session_id).slice(0, 8)}`)
  const input = body.tool_input?.command ?? body.tool_input?.file_path ?? body.tool_input?.url
  if (input) parts.push(JSON.stringify(String(input).slice(0, 60)))
  return parts.join(' ')
}

/** The PermissionRequest decision response in the documented shape. */
function decision(behavior) {
  const body = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } }
  if (behavior === 'deny') body.hookSpecificOutput.decision.message = 'Denied by the ClaudeSwitcher M2 spike harness.'
  return JSON.stringify(body)
}

function serve() {
  if (!existsSync(WORKSPACE)) {
    console.error(`The spike folder is missing: ${WORKSPACE}`)
    process.exit(1)
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = { _unparsed: raw }
      }
      const event = (req.url ?? '').replace(/^\/hook\//, '') || '(root)'
      const received = Date.now()
      log({ kind: 'request', event, url: req.url, body })

      const respond = (status, payload, note) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(payload)
        const heldMs = Date.now() - received
        log({ kind: 'response', event, status, payload, heldMs, note })
        console.log(`${time()}  ← ${event} response: ${note} (after ${Math.round(heldMs / 1000)} s)`)
      }

      console.log(`${time()}  → ${event}  ${short(body)}`)

      const { mode, seconds } = readMode()

      // PreToolUse gets a decision only in `custom` mode, and only if respond.mjs exports a
      // `preToolUse` function, so the earlier measurements behave as before.
      if (event === 'PreToolUse' && mode === 'custom') {
        import(`${pathToFileURL(RESPOND_FILE).href}?t=${Date.now()}`)
          .then((mod) => {
            const out = mod.preToolUse?.(body)
            if (out === undefined) return respond(200, '', 'empty 200')
            respond(200, JSON.stringify(out), `custom PreToolUse: ${out.hookSpecificOutput?.permissionDecision ?? '?'}`)
          })
          .catch((error) => respond(200, '', `custom PreToolUse ERROR: ${error.message}, empty 200`))
        return
      }

      // Only PermissionRequest gets a decision; everything else gets an empty 200 at once.
      if (event !== 'PermissionRequest') return respond(200, '', 'empty 200')

      if (mode === 'pass') return respond(200, '', 'pass: no decision')
      if (mode === 'allow') return respond(200, decision('allow'), 'ALLOW')
      if (mode === 'deny') return respond(200, decision('deny'), 'DENY')
      if (mode === 'custom') {
        // The query string is a cache buster: without it Node would load the module only once.
        import(`${pathToFileURL(RESPOND_FILE).href}?t=${Date.now()}`)
          .then((mod) => {
            const out = mod.default(body)
            if (out === undefined) return respond(200, '', 'custom: no decision')
            respond(200, JSON.stringify(out), `custom: ${out.hookSpecificOutput?.decision?.behavior ?? '?'}`)
          })
          .catch((error) => {
            console.error(error)
            respond(200, '', `custom ERROR: ${error.message}, empty 200`)
          })
        return
      }
      if (mode === 'allow-rule') {
        // Allows, and asks for Claude Code's OWN suggestion to be written as a project-level rule.
        // Deliberately only the `localSettings` destination: the spike folder's
        // .claude/settings.local.json. `userSettings` would write to the global configuration: not
        // measured here.
        const rules = (body.permission_suggestions ?? []).filter((s) => s.type === 'addRules')
        const updatedPermissions = rules.map((s) => ({ ...s, destination: 'localSettings' }))
        const payload = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow', updatedPermissions },
          },
        })
        return respond(200, payload, `ALLOW + ${updatedPermissions.length} rule(s) (localSettings)`)
      }

      console.log(`${time()}     holding ${seconds} s (${mode})…`)
      // If the client drops the connection meanwhile (e.g. Claude Code's timeout), we measure that
      // too.
      //
      // We listen to the close event of `res`, NOT of `req`. Since Node 16 the 'close' of `req`
      // fires as soon as the request body has been read: in the smoke test this made the hold never
      // respond, and it looked exactly as if Claude Code had dropped the connection. The 'close' of
      // `res` comes before the response is sent only on a real disconnect.
      let closed = false
      res.on('close', () => {
        if (!res.writableEnded) {
          closed = true
          log({ kind: 'client-closed', event, heldMs: Date.now() - received })
          console.log(`${time()}  ✕ the client dropped the connection after ${Math.round((Date.now() - received) / 1000)} s`)
        }
      })
      setTimeout(() => {
        if (closed) return
        if (mode === 'hold') respond(200, '', `hold expired: empty 200`)
        else respond(200, decision('allow'), `allow-after: ALLOW`)
      }, seconds * 1000)
    })
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Permission spike server: http://127.0.0.1:${PORT}   log: ${LOG}`)
    console.log(`PermissionRequest mode: ${JSON.stringify(readMode())}`)
  })
}

function setMode(mode, seconds) {
  if (!MODES.has(mode)) {
    console.error(`Unknown mode: ${mode}. Possible: ${[...MODES].join(', ')}`)
    process.exit(1)
  }
  const value = { mode, seconds: Number(seconds ?? 0) }
  writeFileSync(MODE_FILE, JSON.stringify(value), 'utf8')
  console.log(`PermissionRequest mode: ${JSON.stringify(value)}`)
}

function summary() {
  if (!existsSync(LOG)) return console.log('No log yet.')
  const lines = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const counts = {}
  for (const l of lines) {
    if (l.kind === 'request') counts[`http:${l.event}`] = (counts[`http:${l.event}`] ?? 0) + 1
    if (l.kind === 'command-hook') counts[`cmd:${l.event}`] = (counts[`cmd:${l.event}`] ?? 0) + 1
  }
  console.log('Events:', JSON.stringify(counts))
  for (const l of lines) {
    const t = l.at.slice(11, 19)
    if (l.kind === 'request') console.log(`${t}  → http ${l.event.padEnd(18)} ${short(l.body)}`)
    else if (l.kind === 'command-hook') console.log(`${t}  → cmd  ${l.event.padEnd(18)} ${short(l.body)}`)
    else if (l.kind === 'response') console.log(`${t}  ← http ${l.event.padEnd(18)} ${l.note} (${Math.round(l.heldMs / 1000)} s)`)
    else if (l.kind === 'client-closed') console.log(`${t}  ✕ http ${l.event.padEnd(18)} client dropped (${Math.round(l.heldMs / 1000)} s)`)
  }
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined) serve()
else if (command === 'mode') setMode(rest[0], rest[1])
else if (command === 'summary') summary()
else {
  console.error(`Unknown command: ${command}`)
  process.exit(1)
}
