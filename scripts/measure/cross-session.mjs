// Usage: node scripts/measure/cross-session.mjs [days=7]
// Read only. Links the cross-session messages between Claude Code sessions of the last `days` days:
// a sender's `SendMessage` tool_use to the recipient's `queue-operation` `enqueue` of the same text.
// For each link it measures how long the recipient worked on it, whether it replied, and how long the
// sender sat finished (its turn ended) while the recipient was still working: the case where the
// sender's row shows a misleading ✓. Prints session names and counts, never message text.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @typedef {Record<string, unknown>} Rec
 * @typedef {{ t: number, to: string, key: string }} Send
 * @typedef {{ t: number, from: string, hop: string | undefined, fromName: string, mode: string, key: string }} Arrival
 * @typedef {{ id: string, dir: string, title: string, sends: Send[], arrivals: Arrival[], ends: number[], starts: number[] }} Session
 * @typedef {{ sender: Session, send: Send, r: Session, a: Arrival, work: number | undefined, reply: number | undefined, idleWhileWorking: number }} Link
 * @typedef {{ n: number, modes: Record<string, number>, replies: number, idle: number[] }} Pair
 */

/** @type {(value: unknown) => Rec | undefined} */
const rec = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {Rec} */ (value) : undefined)

const days = Number(process.argv[2] ?? 7)
const since = Date.now() - days * 86_400_000
const claude = path.join(os.homedir(), '.claude')
const projects = path.join(claude, 'projects')

/** @type {Map<string, string>} */
const registryName = new Map()
for (const file of fs.readdirSync(path.join(claude, 'sessions'))) {
  if (!file.endsWith('.json')) continue
  try {
    const r = rec(JSON.parse(fs.readFileSync(path.join(claude, 'sessions', file), 'utf8')))
    if (typeof r?.['sessionId'] === 'string' && typeof r['name'] === 'string') registryName.set(r['sessionId'], r['name'])
  } catch {
    // An unreadable registry file names no session.
  }
}

/** @type {(content: unknown) => string} */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((/** @type {unknown} */ b) => {
            const text = rec(b)?.['text']
            return typeof text === 'string' ? text : ''
          })
          .join('\n')
      : ''
/** @type {(text: string) => string} */
const key = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 80)
/** @type {(r: Rec) => number} */
const at = (r) => (typeof r['timestamp'] === 'string' ? Date.parse(r['timestamp']) : NaN)
const HEADER = /<cross-session-message from="([^"]*)"(?: hop-chain="([^"]*)")? from-name="([^"]*)" from-mode="([^"]*)">\s*([\s\S]*)/

/** @type {Session[]} */
const sessions = []
for (const dir of fs.readdirSync(projects)) {
  const full = path.join(projects, dir)
  if (!fs.statSync(full).isDirectory()) continue
  for (const file of fs.readdirSync(full)) {
    if (!file.endsWith('.jsonl')) continue
    const filePath = path.join(full, file)
    if (fs.statSync(filePath).mtimeMs < since) continue
    const id = file.slice(0, -6)
    /** @type {Session} */
    const s = { id, dir, title: '', sends: [], arrivals: [], ends: [], starts: [] }
    /** @type {string | undefined} */
    let custom
    /** @type {string | undefined} */
    let ai
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.includes('{')) continue
      /** @type {Rec | undefined} */
      let r
      try {
        r = rec(JSON.parse(line))
      } catch {
        continue
      }
      if (r === undefined) continue
      if (r['type'] === 'custom-title' && typeof r['customTitle'] === 'string') custom = r['customTitle']
      if (r['type'] === 'ai-title' && typeof r['aiTitle'] === 'string') ai = r['aiTitle']
      const t = at(r)
      const message = rec(r['message'])
      const content = message?.['content']
      if (r['type'] === 'assistant' && message !== undefined && Array.isArray(content)) {
        for (const item of content) {
          const b = rec(item)
          const input = rec(b?.['input'])
          const text = input?.['message']
          if (b?.['type'] === 'tool_use' && b['name'] === 'SendMessage' && typeof text === 'string') {
            const to = input?.['to']
            s.sends.push({ t, to: typeof to === 'string' ? to : '', key: key(text) })
          }
        }
        if (message['stop_reason'] === 'end_turn' || message['model'] === '<synthetic>') s.ends.push(t)
      }
      if (r['type'] === 'queue-operation' && r['operation'] === 'enqueue') {
        const m = HEADER.exec(textOf(r['content']))
        if (m) s.arrivals.push({ t, from: m[1] ?? '', hop: m[2], fromName: m[3] ?? '', mode: m[4] ?? '', key: key(m[5] ?? '') })
        else s.starts.push(t)
      }
      if (r['type'] === 'user' && r['isMeta'] !== true && typeof content === 'string' && !content.startsWith('<')) s.starts.push(t)
    }
    s.title = registryName.get(id) ?? custom ?? ai ?? id.slice(0, 8)
    if (s.sends.length + s.arrivals.length > 0) sessions.push(s)
  }
}
for (const s of sessions) for (const list of [s.ends, s.starts]) list.sort((a, b) => a - b)

/** @type {(list: number[], t: number) => number | undefined} */
const firstAfter = (list, t) => list.find((x) => x >= t)
/** @type {Link[]} */
const linked = []
let calls = 0
for (const sender of sessions) {
  for (const send of sender.sends) {
    if (Number.isNaN(send.t) || send.t < since) continue
    calls++
    /** @type {{ r: Session, a: Arrival } | undefined} */
    let best
    for (const r of sessions) {
      if (r === sender) continue
      for (const a of r.arrivals) {
        if (a.key !== send.key || Math.abs(a.t - send.t) > 120_000) continue
        if (!best || Math.abs(a.t - send.t) < Math.abs(best.a.t - send.t)) best = { r, a }
      }
    }
    if (!best) continue
    const { r, a } = best
    const rEnd = firstAfter(r.ends, a.t)
    const sEnd = firstAfter(sender.ends, send.t)
    const sNext = sEnd === undefined ? undefined : firstAfter(sender.starts, sEnd + 1)
    const reply = r.sends.find((x) => x.t > a.t && sessions.some((o) => o === sender && o.arrivals.some((y) => y.key === x.key)))
    let idleWhileWorking = 0
    if (sEnd !== undefined && rEnd !== undefined && rEnd > sEnd) {
      idleWhileWorking = Math.min(rEnd, sNext ?? Infinity) - sEnd
    }
    linked.push({ sender, send, r, a, work: rEnd === undefined ? undefined : rEnd - a.t, reply: reply?.t, idleWhileWorking })
  }
}

/** @type {(ms: number | undefined) => string} */
const min = (ms) => (ms === undefined ? '-' : `${(ms / 60000).toFixed(1)}p`)
/** @type {(xs: number[], p: number) => number | undefined} */
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : undefined
}

console.log(`Sessions with messages in the last ${String(days)} days: ${String(sessions.length)}`)
console.log(`SendMessage calls: ${String(calls)}, linked to an arrival: ${String(linked.length)}`)
/** @type {Map<string, Pair>} */
const pairs = new Map()
for (const l of linked) {
  const k = `${l.sender.title} -> ${l.r.title}`
  const p = pairs.get(k) ?? { n: 0, modes: {}, replies: 0, idle: [] }
  p.n++
  p.modes[l.a.mode] = (p.modes[l.a.mode] ?? 0) + 1
  if (l.reply) p.replies++
  if (l.idleWhileWorking > 0) p.idle.push(l.idleWhileWorking)
  pairs.set(k, p)
}
console.log('\nPairs (sender -> recipient): messages, modes, replied, misleading-✓ cases and their median length')
for (const [k, p] of [...pairs].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `  ${k}: ${String(p.n)}, ${JSON.stringify(p.modes)}, replied ${String(p.replies)}, sender finished while recipient worked ${String(p.idle.length)}x (median ${min(pct(p.idle, 50))})`,
  )
}
/** @type {Map<string, Set<string>>} */
const out = new Map()
/** @type {Map<string, Set<string>>} */
const inn = new Map()
for (const l of linked) {
  out.set(l.sender.title, new Set([...(out.get(l.sender.title) ?? []), l.r.title]))
  inn.set(l.r.title, new Set([...(inn.get(l.r.title) ?? []), l.sender.title]))
}
console.log('\nPer session: sends to how many, receives from how many')
for (const s of sessions) {
  console.log(
    `  ${s.title}: to ${String(out.get(s.title)?.size ?? 0)}, from ${String(inn.get(s.title)?.size ?? 0)}, hop-chain arrivals ${String(s.arrivals.filter((a) => a.hop).length)}/${String(s.arrivals.length)}`,
  )
}
const works = linked.map((l) => l.work).filter((x) => x !== undefined)
const idles = linked.map((l) => l.idleWhileWorking).filter((x) => x > 0)
const replies = linked.flatMap((l) => (l.reply ? [l.reply - l.a.t] : []))
console.log(`\nRecipient work per message: p50 ${min(pct(works, 50))}, p90 ${min(pct(works, 90))}`)
console.log(`Sender finished while the recipient still worked: ${String(idles.length)} of ${String(linked.length)}, p50 ${min(pct(idles, 50))}, p90 ${min(pct(idles, 90))}`)
console.log(`Replied back: ${String(replies.length)} of ${String(linked.length)}, latency p50 ${min(pct(replies, 50))}, p90 ${min(pct(replies, 90))}`)
// Concurrency: per sender, the most recipients working for it at the same moment.
for (const s of sessions) {
  const spans = linked.flatMap((l) => (l.sender === s && l.work !== undefined ? [[l.a.t, l.a.t + l.work]] : []))
  let peak = 0
  for (const [t] of spans) peak = Math.max(peak, spans.filter(([a = 0, b = 0]) => t !== undefined && a <= t && t < b).length)
  if (peak > 1) console.log(`  ${s.title}: up to ${String(peak)} recipients working at once`)
}
