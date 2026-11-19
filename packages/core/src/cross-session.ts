import { isRecord } from './guards.js'
import type { PromptSender } from './types.js'

/**
 * The transcript records of a cross-session message (another session's `SendMessage`) in the
 * RECIPIENT's transcript, and the record that ends the turn handling it: the one home of their
 * types, field names and markers. Measured 2026-11-19 on 611 arrivals in 25 transcripts of
 * 2026-10-18 to 2026-11-19, Claude Code 2.1.301 to 2.1.328, most of them 2.1.325 (design doc
 * "Cross-session messages"):
 *
 * - The arrival: `{"type":"queue-operation","operation":"enqueue","content":"<cross-session-message
 *   from=\"uds:<pipe>\" hop-chain=\"…\" from-name=\"<name>\" from-mode=\"prompting\">…"}`, with
 *   `hop-chain` optional. `<pipe>` is the sender's registry `messagingSocketPath`, character for
 *   character: of the 734 `from` values in `enqueue` and `remove` records, 576 matched a pipe in the
 *   registry of that day, and the others no current entry.
 * - The delivery, when the recipient takes the message up: mostly while idle (488), a
 *   `queue-operation` `dequeue` and a `user` record whose `origin` is
 *   `{"kind":"peer","from":"uds:<pipe>","name":…}`, which starts a turn; mostly while busy (123), an
 *   `attachment` of type `queued_command` with the same `origin` and a `queue-operation` `remove`
 *   (`reason: "absorbed_mid_turn"`): the message joins the running turn. Every arrival was
 *   delivered in one of the two ways. A message that arrives during a turn that then ends without
 *   absorbing it is dequeued after that turn's end and starts the next turn.
 * - The turn's end: an `assistant` record with `message.stop_reason: "end_turn"`, or a synthetic one
 *   (`message.model: "<synthetic>"`, an API error or the usage limit). Every delivery was followed by
 *   one. A turn the user interrupts ends without either (2 of 611 deliveries); its senders then stay
 *   until the next turn's end.
 * - A `peer` origin whose `from` has no `uds:` (a 17-hex id, with `senderTaskId` and `handback`) is
 *   a subagent handing back inside the same session, not a cross-session message.
 */
const RECORD = {
  queue: 'queue-operation',
  enqueue: 'enqueue',
  tag: '<cross-session-message',
  from: 'from',
  fromName: 'from-name',
  pipePrefix: 'uds:',
  user: 'user',
  attachment: 'attachment',
  queuedCommand: 'queued_command',
  peer: 'peer',
  body: 'body',
  endTurn: 'end_turn',
  synthetic: '<synthetic>',
} as const

/**
 * Substrings one of which every record above has in its raw JSON line, so a line without any of
 * them can be skipped unparsed (`mayConcernPrompts`). Claude Code writes the values unescaped
 * (measured: the counts of `<synthetic>` and `"model":"<synthetic>"` lines agree).
 */
const LINE_MARKERS = [RECORD.tag, `"${RECORD.peer}"`, RECORD.endTurn, RECORD.synthetic] as const

/** Whether a raw transcript line may be one of the records above (`LINE_MARKERS`); a cheap pre-filter. */
export function mayConcernPrompts(line: string): boolean {
  return LINE_MARKERS.some((marker) => line.includes(marker))
}

/** The sender a `from` value names, without the `uds:` prefix; `undefined` for any other `from`. */
function senderOf(from: unknown, name: unknown): PromptSender | undefined {
  if (typeof from !== 'string' || !from.startsWith(RECORD.pipePrefix)) return undefined
  const pipe = from.slice(RECORD.pipePrefix.length)
  if (pipe === '') return undefined
  return typeof name === 'string' && name !== '' ? { pipe, name } : { pipe }
}

/** The attributes of the message's opening tag (`name="value"`, values without quotes inside). */
function tagAttributes(content: string): Map<string, string> {
  const end = content.indexOf('>')
  const tag = end === -1 ? content : content.slice(0, end)
  return new Map([...tag.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map((match) => [match[1] ?? '', match[2] ?? '']))
}

/** The sender of an arrival (the `enqueue` of a cross-session message), else `undefined`. */
function arrivalOf(rec: Record<string, unknown>): PromptSender | undefined {
  if (rec['type'] !== RECORD.queue || rec['operation'] !== RECORD.enqueue) return undefined
  const content = rec['content']
  if (typeof content !== 'string' || !content.startsWith(`${RECORD.tag} `)) return undefined
  const attributes = tagAttributes(content)
  return senderOf(attributes.get(RECORD.from), attributes.get(RECORD.fromName))
}

/**
 * Where a delivered prompt's `origin` lives: the `user` record itself, or the `attachment` of a
 * `queued_command` record (a prompt that joined the running turn). `conversation.ts` reads the
 * user's own prompts from the same two places (with `origin.kind: "human"`). `undefined` for any
 * other record.
 */
export function deliveryOf(rec: Record<string, unknown>): { holder: Record<string, unknown>; queued: boolean } | undefined {
  if (rec['type'] === RECORD.user) return { holder: rec, queued: false }
  const attachment = rec['attachment']
  if (rec['type'] === RECORD.attachment && isRecord(attachment) && attachment['type'] === RECORD.queuedCommand) {
    return { holder: attachment, queued: true }
  }
  return undefined
}

/** Whether a raw line may be a `queued_command` attachment (`deliveryOf`); a cheap pre-filter for `conversation.ts`. */
export function mayBeQueuedDelivery(line: string): boolean {
  return line.includes(`"${RECORD.queuedCommand}"`)
}

/** The peer `origin` of a delivery (`deliveryOf`), else `undefined`. */
function peerOriginOf(rec: Record<string, unknown>): Record<string, unknown> | undefined {
  const origin = deliveryOf(rec)?.holder['origin']
  return isRecord(origin) && origin['kind'] === RECORD.peer ? origin : undefined
}

/** The sender of a delivery (a `user` record or a `queued_command` attachment with a peer origin), else `undefined`. */
function deliverySenderOf(rec: Record<string, unknown>): PromptSender | undefined {
  const origin = peerOriginOf(rec)
  return origin === undefined ? undefined : senderOf(origin['from'], origin['name'])
}

/**
 * The sender and the text of a delivered cross-session message, for the conversation view
 * (`conversation.ts`), else `undefined` (a subagent's handback included: its `from` has no `uds:`).
 * The text is the origin's `body`: measured 2026-11-19 on the deliveries of 7 days (483 `user`
 * records, 122 `queued_command` attachments), the record's own content holds the body too, but
 * wrapped in Claude Code's preamble and the `<cross-session-message>` tag.
 */
export function peerMessageOf(rec: Record<string, unknown>): { sender: PromptSender; body: string } | undefined {
  const origin = peerOriginOf(rec)
  if (origin === undefined) return undefined
  const sender = senderOf(origin['from'], origin['name'])
  const body = origin[RECORD.body]
  return sender === undefined || typeof body !== 'string' ? undefined : { sender, body }
}

/** Whether the record ends a turn (see `RECORD`). */
export function isTurnEnd(rec: Record<string, unknown>): boolean {
  if (rec['type'] !== 'assistant' || !isRecord(rec['message'])) return false
  return rec['message']['stop_reason'] === RECORD.endTurn || rec['message']['model'] === RECORD.synthetic
}

/**
 * Follows the records of a transcript in file order (`see`) and tells which senders the session
 * works for after them (`senders`). A sender is pending from its arrival: while one of its messages
 * waits in the queue (arrivals minus deliveries, per sender), and from a delivery until the end of
 * the turn that handles it. One entry per sender, in the order they first became pending; the name
 * is the latest one seen.
 */
export function createPromptTracker(): {
  see(rec: Record<string, unknown>): void
  senders(): PromptSender[]
} {
  const queued = new Map<string, number>()
  const inTurn = new Set<string>()
  const names = new Map<string, string>()
  const order: string[] = []

  const note = (sender: PromptSender): void => {
    if (sender.name !== undefined) names.set(sender.pipe, sender.name)
    if (!order.includes(sender.pipe)) order.push(sender.pipe)
  }
  const pending = (pipe: string): boolean => (queued.get(pipe) ?? 0) > 0 || inTurn.has(pipe)

  return {
    see(rec) {
      const arrival = arrivalOf(rec)
      if (arrival !== undefined) {
        note(arrival)
        queued.set(arrival.pipe, (queued.get(arrival.pipe) ?? 0) + 1)
        return
      }
      const delivery = deliverySenderOf(rec)
      if (delivery !== undefined) {
        note(delivery)
        // A delivery whose arrival lies before the lines read takes nothing from the queue.
        const waiting = queued.get(delivery.pipe) ?? 0
        if (waiting > 0) queued.set(delivery.pipe, waiting - 1)
        inTurn.add(delivery.pipe)
        return
      }
      if (isTurnEnd(rec)) {
        inTurn.clear()
        // Forget the senders no longer pending, so the order restarts with the next ones.
        for (let i = order.length - 1; i >= 0; i--) {
          const pipe = order[i]
          if (pipe !== undefined && !pending(pipe)) order.splice(i, 1)
        }
      }
    },
    senders() {
      return order.filter(pending).map((pipe) => {
        const name = names.get(pipe)
        return name === undefined ? { pipe } : { pipe, name }
      })
    },
  }
}
