#!/usr/bin/env node
// M2 spike — mérőszerver a Claude Code hookjaihoz.
//
// Nem termékkód. Egyetlen célja, hogy a spec §10 kérdéseit MÉRÉSSEL döntsük el: lefut-e a
// PermissionRequest a VSCode bővítményben, mi történik, ha tartjuk a választ, és mi jön a
// payloadban. Ezért mindent NYERSEN naplóz, és a PermissionRequest-re vezérelhetően reagál.
//
// Használat:
//   node server.mjs                     a szerver indítása (előtérben, Ctrl+C állítja le)
//   node server.mjs mode pass           PermissionRequest: üres 200, nincs döntés
//   node server.mjs mode hold 60        PermissionRequest: 60 mp tartás, utána üres 200
//   node server.mjs mode allow          PermissionRequest: engedélyez
//   node server.mjs mode deny           PermissionRequest: tilt
//   node server.mjs mode allow-after 30 PermissionRequest: 30 mp tartás, utána engedélyez
//   node server.mjs summary             a napló összefoglalása
//
// Csak 127.0.0.1-re köt, függőség nélkül fut.

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

// A `custom` mód a választ a spike mappa `respond.mjs`-éből állítja elő, minden kérésnél frissen
// betöltve. Így egy új méréshez csak azt a fájlt kell átírni, a szervert nem kell újraindítani.
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

/** A PermissionRequest döntési válasza a dokumentált alakban. */
function decision(behavior) {
  const body = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } }
  if (behavior === 'deny') body.hookSpecificOutput.decision.message = 'Denied by the ClaudeSwitcher M2 spike harness.'
  return JSON.stringify(body)
}

function serve() {
  if (!existsSync(WORKSPACE)) {
    console.error(`Nincs meg a spike mappa: ${WORKSPACE}`)
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
        console.log(`${time()}  ← ${event} válasz: ${note} (${Math.round(heldMs / 1000)} mp után)`)
      }

      console.log(`${time()}  → ${event}  ${short(body)}`)

      const { mode, seconds } = readMode()

      // A PreToolUse csak `custom` módban kaphat döntést, és csak ha a respond.mjs exportál
      // `preToolUse` függvényt — így a korábbi mérések viselkedése nem változik.
      if (event === 'PreToolUse' && mode === 'custom') {
        import(`${pathToFileURL(RESPOND_FILE).href}?t=${Date.now()}`)
          .then((mod) => {
            const out = mod.preToolUse?.(body)
            if (out === undefined) return respond(200, '', 'üres 200')
            respond(200, JSON.stringify(out), `custom PreToolUse — ${out.hookSpecificOutput?.permissionDecision ?? '?'}`)
          })
          .catch((error) => respond(200, '', `custom PreToolUse HIBA: ${error.message} — üres 200`))
        return
      }

      // Csak a PermissionRequest kap döntést; minden más azonnal üres 200.
      if (event !== 'PermissionRequest') return respond(200, '', 'üres 200')

      if (mode === 'pass') return respond(200, '', 'pass — nincs döntés')
      if (mode === 'allow') return respond(200, decision('allow'), 'ALLOW')
      if (mode === 'deny') return respond(200, decision('deny'), 'DENY')
      if (mode === 'custom') {
        // A query string cache-buster: enélkül a Node a modult csak egyszer töltené be.
        import(`${pathToFileURL(RESPOND_FILE).href}?t=${Date.now()}`)
          .then((mod) => {
            const out = mod.default(body)
            if (out === undefined) return respond(200, '', 'custom — nincs döntés')
            respond(200, JSON.stringify(out), `custom — ${out.hookSpecificOutput?.decision?.behavior ?? '?'}`)
          })
          .catch((error) => {
            console.error(error)
            respond(200, '', `custom HIBA: ${error.message} — üres 200`)
          })
        return
      }
      if (mode === 'allow-rule') {
        // Engedélyez, és a Claude Code SAJÁT javaslatát kéri beírni projekt-szintű szabályként.
        // Szándékosan csak `localSettings` cél: a spike mappa .claude/settings.local.json-je.
        // A `userSettings` a globális konfigodba írna — azt itt nem mérjük.
        const rules = (body.permission_suggestions ?? []).filter((s) => s.type === 'addRules')
        const updatedPermissions = rules.map((s) => ({ ...s, destination: 'localSettings' }))
        const payload = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow', updatedPermissions },
          },
        })
        return respond(200, payload, `ALLOW + ${updatedPermissions.length} szabály (localSettings)`)
      }

      console.log(`${time()}     tartás ${seconds} mp (${mode})…`)
      // Ha a kliens közben bontja a kapcsolatot (pl. a Claude Code timeoutja), azt is mérjük.
      //
      // A `res` close eseményét figyeljük, NEM a `req`-ét. A Node 16 óta a `req` 'close'-a
      // már akkor lefut, amikor a kérés törzse beolvasásra került — a füstpróbán ez azt
      // okozta, hogy a tartás soha nem válaszolt, és pont úgy nézett ki, mint ha a Claude
      // Code bontaná a kapcsolatot. A `res` 'close'-a csak valódi bontáskor jön a válasz
      // elküldése előtt.
      let closed = false
      res.on('close', () => {
        if (!res.writableEnded) {
          closed = true
          log({ kind: 'client-closed', event, heldMs: Date.now() - received })
          console.log(`${time()}  ✕ a kliens bontotta a kapcsolatot ${Math.round((Date.now() - received) / 1000)} mp után`)
        }
      })
      setTimeout(() => {
        if (closed) return
        if (mode === 'hold') respond(200, '', `hold lejárt — üres 200`)
        else respond(200, decision('allow'), `allow-after — ALLOW`)
      }, seconds * 1000)
    })
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`M2 spike szerver: http://127.0.0.1:${PORT}   napló: ${LOG}`)
    console.log(`PermissionRequest mód: ${JSON.stringify(readMode())}`)
  })
}

function setMode(mode, seconds) {
  if (!MODES.has(mode)) {
    console.error(`Ismeretlen mód: ${mode}. Lehetséges: ${[...MODES].join(', ')}`)
    process.exit(1)
  }
  const value = { mode, seconds: Number(seconds ?? 0) }
  writeFileSync(MODE_FILE, JSON.stringify(value), 'utf8')
  console.log(`PermissionRequest mód: ${JSON.stringify(value)}`)
}

function summary() {
  if (!existsSync(LOG)) return console.log('Még nincs napló.')
  const lines = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const counts = {}
  for (const l of lines) {
    if (l.kind === 'request') counts[`http:${l.event}`] = (counts[`http:${l.event}`] ?? 0) + 1
    if (l.kind === 'command-hook') counts[`cmd:${l.event}`] = (counts[`cmd:${l.event}`] ?? 0) + 1
  }
  console.log('Események:', JSON.stringify(counts))
  for (const l of lines) {
    const t = l.at.slice(11, 19)
    if (l.kind === 'request') console.log(`${t}  → http ${l.event.padEnd(18)} ${short(l.body)}`)
    else if (l.kind === 'command-hook') console.log(`${t}  → cmd  ${l.event.padEnd(18)} ${short(l.body)}`)
    else if (l.kind === 'response') console.log(`${t}  ← http ${l.event.padEnd(18)} ${l.note} (${Math.round(l.heldMs / 1000)} mp)`)
    else if (l.kind === 'client-closed') console.log(`${t}  ✕ http ${l.event.padEnd(18)} kliens bontott (${Math.round(l.heldMs / 1000)} mp)`)
  }
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined) serve()
else if (command === 'mode') setMode(rest[0], rest[1])
else if (command === 'summary') summary()
else {
  console.error(`Ismeretlen parancs: ${command}`)
  process.exit(1)
}
