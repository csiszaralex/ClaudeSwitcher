import { deliveryOf, mayBeQueuedDelivery, peerMessageOf } from './cross-session.js'
import { flatText, isRecord, parseRecordLine, truncate } from './guards.js'
import { toolDetail } from './tool-detail.js'
import type { PromptSender } from './types.js'

/**
 * The transcript records the conversation view (the overlay's peek) shows, the one home of their
 * field names and markers. Measured 2026-11-19 on the owner's transcripts of the last 7 days (44
 * files, 271 978 lines, Claude Code 2.1.215 to 2.1.328, the most common 2.1.325; design doc "The
 * conversation"):
 *
 * - The user's prompt: a `user` record with `origin: {"kind":"human"}` and no `isMeta` (2 705), its
 *   `message.content` a string or an array of `text` and `image` blocks. A text block that is only
 *   the IDE's or the browser's context (`<ide_opened_file>`, `<ide_selection>`,
 *   `<browser_instruction>`, 144 blocks, each in a prompt of two or more blocks) is not the user's
 *   text; nor is a `<system-reminder>` block, which no prompt had. A prompt typed while the session
 *   works joins the running turn as a `queued_command` attachment (`cross-session.ts` `deliveryOf`)
 *   with the same origin and the text in its `prompt` (170; only 3 had a `user` record with the
 *   same text, so it is no copy).
 * - A slash command: a `user` record without an `origin`, its content a string
 *   `<command-name>/name</command-name><command-message>…</command-message><command-args>…</command-args>`
 *   (59). Its output (`<local-command-stdout>`, 57) and the caveat before it (`isMeta`,
 *   `<local-command-caveat>`, 59) are left out.
 * - The answer: an `assistant` record's `text` blocks, its tool calls its `tool_use` blocks (`name`,
 *   `input`); its `thinking` blocks are left out.
 * - An incoming cross-session message: `cross-session.ts` `peerMessageOf`.
 * - Left out besides: tool results (`user` records with `toolUseResult`, 32 345), the other `isMeta`
 *   records (the system reminders among them), the compacted summary (`isCompactSummary`, 108), the
 *   background tasks' notices (`origin.kind: "task-notification"`, 863 `user` records, and as
 *   `queued_command` attachments), the other attachments, every other record type (`system`,
 *   `api-request`, the title records and the rest), and records of a subagent's side chain
 *   (`isSidechain`, none in a session's own transcript). Also left out: 22 plain-text `user` records
 *   without an `origin` and not compacted (15 of Claude Code 2.1.2xx, 7 of 2.1.3xx), whose kind
 *   was not measured.
 */
const RECORD = {
  user: 'user',
  assistant: 'assistant',
  message: 'message',
  content: 'content',
  queuedPrompt: 'prompt',
  origin: 'origin',
  human: 'human',
  isMeta: 'isMeta',
  isSidechain: 'isSidechain',
  isCompactSummary: 'isCompactSummary',
  toolUseResult: 'toolUseResult',
  commandName: 'command-name',
  commandArgs: 'command-args',
} as const

/** The context tags a prompt's text block may consist of; such a block is not the user's text. */
const CONTEXT_TAGS = ['ide_opened_file', 'ide_selection', 'browser_instruction', 'system-reminder'] as const

/** The most characters one entry's text keeps (`ConversationEntry` `truncated`), so one huge answer cannot freeze the view. */
export const CONVERSATION_ENTRY_MAX = 20_000

/** The most characters a slash command's line keeps (the name and its arguments, on one line). */
const COMMAND_MAX = 200

/** How many turns the view shows: a turn starts at a prompt, a slash command or an incoming message. */
export const CONVERSATION_TURNS = 20

/** One shown piece of the conversation, in file order. */
export type ConversationEntry =
  | {
      kind: 'prompt'
      text: string
      /** How many images the prompt had. */
      images: number
      /** The text was cut at `CONVERSATION_ENTRY_MAX`. */
      truncated: boolean
    }
  /** A slash command, `/name args` on one line. */
  | { kind: 'command'; text: string }
  | { kind: 'answer'; text: string; truncated: boolean }
  /** A tool call, without its output: the name and the short detail (`toolDetail`). */
  | { kind: 'tool'; name: string; detail?: string | undefined }
  /** An incoming cross-session message; the renderer names the sender (its live session's shown name first). */
  | { kind: 'message'; sender: PromptSender; text: string; truncated: boolean }

/** Whether an entry starts a turn (`CONVERSATION_TURNS`). */
function startsTurn(entry: ConversationEntry): boolean {
  return entry.kind === 'prompt' || entry.kind === 'command' || entry.kind === 'message'
}

/**
 * Whether a raw line may hold an entry, so a line without one can be skipped unparsed: it names a
 * `user` or an `assistant` record or a queued prompt, and it is no tool result. Claude Code writes
 * the JSON without spaces, and a quote inside a string value is escaped, so these substrings with
 * their quotes appear only as the keys and values themselves.
 */
export function mayBeConversation(line: string): boolean {
  if (line.includes(`"type":"${RECORD.assistant}"`)) return true
  if (line.includes(`"${RECORD.toolUseResult}"`)) return false
  return line.includes(`"type":"${RECORD.user}"`) || mayBeQueuedDelivery(line)
}

function capped(text: string): { text: string; truncated: boolean } {
  return text.length > CONVERSATION_ENTRY_MAX
    ? { text: text.slice(0, CONVERSATION_ENTRY_MAX), truncated: true }
    : { text, truncated: false }
}

function isContextBlock(text: string): boolean {
  const trimmed = text.trim()
  return CONTEXT_TAGS.some((tag) => trimmed.startsWith(`<${tag}`) && trimmed.endsWith(`</${tag}>`))
}

/** A prompt's text (its own text blocks, joined by an empty line) and its image count. */
function promptOf(content: unknown): ConversationEntry | undefined {
  let text: string
  let images = 0
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block['type'] === 'image') images++
      const value = block['text']
      if (block['type'] === 'text' && typeof value === 'string' && !isContextBlock(value)) texts.push(value)
    }
    text = texts.join('\n\n')
  } else return undefined
  text = text.trim()
  if (text === '' && images === 0) return undefined
  return { kind: 'prompt', images, ...capped(text) }
}

/** The text between `<tag>` and `</tag>`, else `undefined`. */
function tagged(text: string, tag: string): string | undefined {
  const open = text.indexOf(`<${tag}>`)
  if (open === -1) return undefined
  const from = open + tag.length + 2
  const close = text.indexOf(`</${tag}>`, from)
  return close === -1 ? undefined : text.slice(from, close)
}

/** A slash command's line, from a content that starts with `<command-name>`, else `undefined`. */
function commandOf(content: unknown): ConversationEntry | undefined {
  if (typeof content !== 'string' || !content.startsWith(`<${RECORD.commandName}>`)) return undefined
  const name = flatText(tagged(content, RECORD.commandName))
  if (name === undefined) return undefined
  const args = flatText(tagged(content, RECORD.commandArgs))
  return { kind: 'command', text: truncate(args === undefined ? name : `${name} ${args}`, COMMAND_MAX) }
}

function answerEntries(rec: Record<string, unknown>): ConversationEntry[] {
  const message = rec[RECORD.message]
  const content = isRecord(message) ? message[RECORD.content] : undefined
  if (!Array.isArray(content)) return []
  const entries: ConversationEntry[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const text = block['text']
    const name = block['name']
    if (block['type'] === 'text' && typeof text === 'string' && text.trim() !== '') {
      entries.push({ kind: 'answer', ...capped(text.trim()) })
    } else if (block['type'] === 'tool_use' && typeof name === 'string' && name !== '') {
      entries.push({ kind: 'tool', name, detail: toolDetail(block['input']) })
    }
  }
  return entries
}

/** The entries one record gives (see `RECORD`); none for a record the view leaves out. Never throws. */
function conversationEntriesOf(rec: Record<string, unknown>): ConversationEntry[] {
  if (rec[RECORD.isSidechain] === true) return []
  if (rec['type'] === RECORD.assistant) return answerEntries(rec)

  const peer = peerMessageOf(rec)
  if (peer !== undefined) {
    const text = peer.body.trim()
    return text === '' ? [] : [{ kind: 'message', sender: peer.sender, ...capped(text) }]
  }

  const delivery = deliveryOf(rec)
  if (delivery === undefined) return []
  const { holder, queued } = delivery
  if (holder[RECORD.isMeta] === true || holder[RECORD.isCompactSummary] === true) return []
  const message = holder[RECORD.message]
  const content = queued ? holder[RECORD.queuedPrompt] : isRecord(message) ? message[RECORD.content] : undefined
  const origin = holder[RECORD.origin]
  if (isRecord(origin) && origin['kind'] === RECORD.human) {
    const prompt = promptOf(content)
    return prompt === undefined ? [] : [prompt]
  }
  if (queued || origin !== undefined) return []
  const command = commandOf(content)
  return command === undefined ? [] : [command]
}

/**
 * Whether the record is the user's own prompt: the view's `prompt` entry (`origin.kind: "human"` on
 * a `user` record or a `queued_command` attachment, not `isMeta`, not compacted, not a side chain;
 * see `RECORD`). Not a cross-session message, a background task's notice, a tool result, a slash
 * command or its output: a slash command is mostly a local one (measured 2026-11-28 on 7 days, 54
 * transcripts, Claude Code up to 2.1.332: 42 of 49 were followed by their `<local-command-stdout>`),
 * which tells the model nothing. `transcript.ts` `readActivityFromLines` keeps the latest one's time
 * as `SessionActivity.lastOwnPromptAt`.
 */
export function isOwnPrompt(rec: Record<string, unknown>): boolean {
  // An answer is never a prompt; skipping it saves building its entries on every scan.
  return rec['type'] !== RECORD.assistant && conversationEntriesOf(rec).some((entry) => entry.kind === 'prompt')
}

/** How many turns the lines start (`startsTurn`). */
export function countTurnStarts(lines: readonly string[]): number {
  let count = 0
  for (const line of lines) {
    if (!mayBeConversation(line)) continue
    const rec = parseRecordLine(line)
    if (rec !== undefined) count += conversationEntriesOf(rec).filter(startsTurn).length
  }
  return count
}

/**
 * The conversation the lines hold, oldest first, from the start of the last `maxTurns` turns. With
 * fewer turns, everything the lines hold, the end of an earlier turn included. Broken and unknown
 * lines are skipped; never throws.
 */
export function conversationFromLines(lines: readonly string[], maxTurns: number = CONVERSATION_TURNS): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (const line of lines) {
    if (!mayBeConversation(line)) continue
    const rec = parseRecordLine(line)
    if (rec !== undefined) entries.push(...conversationEntriesOf(rec))
  }
  const starts = entries.flatMap((entry, index) => (startsTurn(entry) ? [index] : []))
  const first = starts.length >= maxTurns ? starts[starts.length - maxTurns] : undefined
  return first === undefined ? entries : entries.slice(first)
}
