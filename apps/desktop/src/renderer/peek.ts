import type { ConversationEntry, PromptSender } from '@claudeswitcher/core'
import { isRecord } from '@claudeswitcher/core/browser'
import type { ConversationReply } from '../shared/overlay-channels.js'
import { pendingRowText } from '../shared/row-text.js'
import { activeDecision, pendingBadge } from './rows.js'

/**
 * The peek (Space on a row): the selected session's recent conversation, read only, in place of the
 * list. Pure; App owns its state and its keys (`isPeekKey`, `peekScrollTop`), `PeekPanel.tsx` draws it.
 */

/** How often the open peek asks for the conversation again (main `conversation-reader.ts` answers an unchanged transcript from its cache). */
export const PEEK_REFRESH_MS = 1000

/** The peek's texts. */
export const PEEK_TEXT = {
  loading: 'Betöltés…',
  empty: 'Nincs megjeleníthető beszélgetés.',
  unreadable: 'Nem sikerült beolvasni a beszélgetést.',
  truncated: '… A szöveg itt le van vágva, túl hosszú.',
  /** The status bar's hint while the peek is open. */
  keys: 'Vissza: Szóköz vagy Esc · Ugrás: Enter',
  /** The sender of an incoming message whose name nobody knows. */
  unknownSender: 'Egy másik session',
  /** The label of the bar at the bottom while the peeked session waits on a decision (`peekRequest`). */
  request: 'Döntésre vár:',
  /** How to decide it: Space goes back to the list, where its decision panel shows. */
  decideHere: 'Döntés: Szóköz',
  /** A released request (`PERMISSION_RELEASE_AFTER_MS`): only VS Code can decide it now. */
  decideInVSCode: 'Döntés: VS Code-ban',
} as const

/** The bar at the bottom of the peek (`peekRequest`). */
export interface PeekRequest {
  /** The request as the row shows it (`pendingRowText`). */
  text: string
  /** The row's "N vár" badge (`pendingBadge`), when more than one request can be decided in the app. */
  badge: string | undefined
  /** How to decide it (`PEEK_TEXT.decideHere`, `PEEK_TEXT.decideInVSCode`). */
  hint: string
}

/**
 * The bar at the bottom of the peek while the peeked session waits on a decision: the request the
 * panel would show (`activeDecision`), in the row's words. Only a description: the peek decides
 * nothing (its letter keys rest, App's `onKey`), so a key pressed while reading cannot approve.
 */
export function peekRequest(
  decisions: readonly { toolName: string; summary: string; released: boolean }[],
): PeekRequest | undefined {
  const pending = activeDecision(decisions)
  if (pending === undefined) return undefined
  return {
    text: pendingRowText(pending),
    badge: pendingBadge(decisions),
    hint: pending.released ? PEEK_TEXT.decideInVSCode : PEEK_TEXT.decideHere,
  }
}

/** The key that opens and closes the peek: a plain Space, not held down. */
export function isPeekKey(event: { key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return event.key === ' ' && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

function readSender(raw: unknown): PromptSender | undefined {
  if (!isRecord(raw) || typeof raw['pipe'] !== 'string') return undefined
  const name = raw['name']
  if (name === undefined) return { pipe: raw['pipe'] }
  return typeof name === 'string' ? { pipe: raw['pipe'], name } : undefined
}

/** One entry of the reply, checked field by field; `undefined` for anything malformed. */
function readEntry(raw: unknown): ConversationEntry | undefined {
  if (!isRecord(raw)) return undefined
  const text = raw['text']
  const truncated = raw['truncated']
  switch (raw['kind']) {
    case 'prompt': {
      const images = raw['images']
      if (typeof text !== 'string' || typeof truncated !== 'boolean' || typeof images !== 'number') return undefined
      return { kind: 'prompt', text, images, truncated }
    }
    case 'command':
      return typeof text === 'string' ? { kind: 'command', text } : undefined
    case 'answer':
      return typeof text === 'string' && typeof truncated === 'boolean' ? { kind: 'answer', text, truncated } : undefined
    case 'tool': {
      const name = raw['name']
      const detail = raw['detail']
      if (typeof name !== 'string' || (detail !== undefined && typeof detail !== 'string')) return undefined
      return { kind: 'tool', name, detail }
    }
    case 'message': {
      const sender = readSender(raw['sender'])
      if (sender === undefined || typeof text !== 'string' || typeof truncated !== 'boolean') return undefined
      return { kind: 'message', sender, text, truncated }
    }
    default:
      return undefined
  }
}

/**
 * The main process's `ConversationReply`, checked, because anything can come over the IPC. A
 * malformed entry is dropped, the others stay; anything else counts as unreadable.
 */
export function readConversationReply(raw: unknown): ConversationReply {
  if (isRecord(raw)) {
    const reason = raw['reason']
    if (raw['ok'] === false && (reason === 'unknown-session' || reason === 'missing' || reason === 'unreadable')) {
      return { ok: false, reason }
    }
    const version = raw['version']
    const entries = raw['entries']
    if (raw['ok'] === true && typeof version === 'string' && Array.isArray(entries)) {
      return { ok: true, version, entries: entries.flatMap((entry: unknown) => readEntry(entry) ?? []) }
    }
  }
  return { ok: false, reason: 'unreadable' }
}

/** The line the peek shows instead of the history: while it loads, when there is none, or when it failed. */
export function peekNotice(reply: ConversationReply | undefined): string | undefined {
  if (reply === undefined) return PEEK_TEXT.loading
  if (!reply.ok) return reply.reason === 'unreadable' ? PEEK_TEXT.unreadable : PEEK_TEXT.empty
  return reply.entries.length === 0 ? PEEK_TEXT.empty : undefined
}

/** A tool call's line: the name and its detail (core `toolDetail`), for example `Bash: pnpm verify`. */
export function toolLine(name: string, detail: string | undefined): string {
  return detail === undefined ? name : `${name}: ${detail}`
}

/** The label of an incoming message, before its text: `← <name>`. */
export function senderLabel(name: string | undefined): string {
  return `← ${name ?? PEEK_TEXT.unknownSender}`
}

/** The note after a prompt's text for its images: `(1 kép)`; `undefined` without images. */
export function imagesNote(images: number): string | undefined {
  return images > 0 ? `(${String(images)} kép)` : undefined
}

/** A piece of an entry's text: plain text, or the inside of a fenced code block. */
export interface TextPiece {
  code: boolean
  text: string
}

const FENCE = '```'

/**
 * The text cut at its code fences (a line that starts with ```, indented or not): the fence lines
 * themselves go, with their language tag, and an unclosed fence runs to the end. No other Markdown is
 * read. Empty pieces are left out.
 */
export function textPieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = []
  let code = false
  let lines: string[] = []
  const flush = (): void => {
    const joined = lines.join('\n')
    if (joined.trim() !== '') pieces.push({ code, text: code ? joined : joined.replace(/^\n+|\n+$/g, '') })
    lines = []
  }
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(FENCE)) {
      flush()
      code = !code
    } else lines.push(line)
  }
  flush()
  return pieces
}

/** The part of the history's scroll box the keys read. */
export interface ScrollBox {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/** How far an arrow key scrolls the history (px). */
const LINE_STEP_PX = 40

/** Within this distance from the end (px), the history counts as scrolled to the bottom. */
const BOTTOM_SLACK_PX = 4

/** Whether the history is scrolled to its bottom: then a refresh keeps it there. */
export function isAtBottom(box: ScrollBox): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK_PX
}

/**
 * Where a key scrolls the history: the arrows by a line, PageUp and PageDown by a page less a line,
 * Home and End to either end; `undefined` for any other key. Kept within the box.
 */
export function peekScrollTop(key: string, box: ScrollBox): number | undefined {
  const page = Math.max(LINE_STEP_PX, box.clientHeight - LINE_STEP_PX)
  const max = Math.max(0, box.scrollHeight - box.clientHeight)
  const by = (delta: number): number => Math.min(max, Math.max(0, box.scrollTop + delta))
  switch (key) {
    case 'ArrowDown':
      return by(LINE_STEP_PX)
    case 'ArrowUp':
      return by(-LINE_STEP_PX)
    case 'PageDown':
      return by(page)
    case 'PageUp':
      return by(-page)
    case 'Home':
      return 0
    case 'End':
      return max
    default:
      return undefined
  }
}
