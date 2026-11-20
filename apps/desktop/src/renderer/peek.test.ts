import { describe, expect, it } from 'vitest'
import {
  PEEK_TEXT,
  imagesNote,
  isAtBottom,
  isPeekKey,
  peekNotice,
  peekRequest,
  peekScrollTop,
  readConversationReply,
  senderLabel,
  textPieces,
  toolLine,
} from './peek.js'

const PIPE = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
const plain = { key: ' ', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }

describe('isPeekKey', () => {
  it('takes a plain Space only', () => {
    expect(isPeekKey(plain)).toBe(true)
    expect(isPeekKey({ ...plain, repeat: true })).toBe(false)
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) {
      expect(isPeekKey({ ...plain, [modifier]: true })).toBe(false)
    }
    expect(isPeekKey({ ...plain, key: 'Enter' })).toBe(false)
  })
})

describe('readConversationReply', () => {
  it('reads every kind of entry', () => {
    const entries = [
      { kind: 'prompt', text: 'Szia.', images: 1, truncated: false },
      { kind: 'command', text: '/clear' },
      { kind: 'answer', text: 'Helló.', truncated: true },
      { kind: 'tool', name: 'Bash', detail: 'pnpm verify' },
      { kind: 'tool', name: 'TodoWrite' },
      { kind: 'message', sender: { pipe: PIPE, name: 'Karmester' }, text: 'Nézd meg.', truncated: false },
      { kind: 'message', sender: { pipe: PIPE }, text: 'Név nélkül.', truncated: false },
    ]
    expect(readConversationReply({ ok: true, version: '1:2', entries })).toEqual({
      ok: true,
      version: '1:2',
      entries: [...entries.slice(0, 4), { kind: 'tool', name: 'TodoWrite', detail: undefined }, ...entries.slice(5)],
    })
  })

  it('drops a malformed entry and keeps the others', () => {
    const good = { kind: 'answer', text: 'Jó.', truncated: false }
    const bad = [
      null,
      'x',
      { kind: 'prompt', text: 'x', truncated: false },
      { kind: 'answer', text: 7, truncated: false },
      { kind: 'tool', name: 'Bash', detail: 7 },
      { kind: 'message', sender: { name: 'x' }, text: 'x', truncated: false },
      { kind: 'message', sender: { pipe: PIPE, name: 7 }, text: 'x', truncated: false },
      { kind: 'html', text: '<script>' },
    ]
    expect(readConversationReply({ ok: true, version: 'v', entries: [...bad, good] })).toEqual({ ok: true, version: 'v', entries: [good] })
  })

  it('reads the failure reasons, and anything else as unreadable', () => {
    expect(readConversationReply({ ok: false, reason: 'missing' })).toEqual({ ok: false, reason: 'missing' })
    expect(readConversationReply({ ok: false, reason: 'unknown-session' })).toEqual({ ok: false, reason: 'unknown-session' })
    for (const raw of [undefined, null, 'x', { ok: true }, { ok: true, version: 1, entries: [] }, { ok: false, reason: 'other' }]) {
      expect(readConversationReply(raw)).toEqual({ ok: false, reason: 'unreadable' })
    }
  })
})

describe('peekNotice', () => {
  it('says loading, empty or unreadable, and nothing over a history', () => {
    expect(peekNotice(undefined)).toBe(PEEK_TEXT.loading)
    expect(peekNotice({ ok: true, version: 'v', entries: [] })).toBe(PEEK_TEXT.empty)
    expect(peekNotice({ ok: false, reason: 'missing' })).toBe(PEEK_TEXT.empty)
    expect(peekNotice({ ok: false, reason: 'unknown-session' })).toBe(PEEK_TEXT.empty)
    expect(peekNotice({ ok: false, reason: 'unreadable' })).toBe(PEEK_TEXT.unreadable)
    expect(peekNotice({ ok: true, version: 'v', entries: [{ kind: 'command', text: '/clear' }] })).toBeUndefined()
  })
})

describe('the entry texts', () => {
  it('writes a tool call as name and detail', () => {
    expect(toolLine('Bash', 'pnpm verify')).toBe('Bash: pnpm verify')
    expect(toolLine('TodoWrite', undefined)).toBe('TodoWrite')
  })

  it('names the sender of a message, or says it is another session', () => {
    expect(senderLabel('Karmester')).toBe('← Karmester')
    expect(senderLabel(undefined)).toBe(`← ${PEEK_TEXT.unknownSender}`)
  })

  it('notes the images of a prompt', () => {
    expect(imagesNote(0)).toBeUndefined()
    expect(imagesNote(2)).toBe('(2 kép)')
  })

  it('has no en or em dash inside a sentence', () => {
    for (const text of Object.values(PEEK_TEXT)) expect(text).not.toMatch(/[–—]/)
  })
})

describe('textPieces', () => {
  it('keeps plain text with its line breaks', () => {
    expect(textPieces('Első sor.\nMásodik sor.\n\nÚj bekezdés.')).toEqual([{ code: false, text: 'Első sor.\nMásodik sor.\n\nÚj bekezdés.' }])
  })

  it('cuts out fenced code blocks without their fences, the indentation inside kept', () => {
    const text = 'Futtasd ezt:\n```sh\npnpm verify\n  --watch\n```\nUtána szólj.'
    expect(textPieces(text)).toEqual([
      { code: false, text: 'Futtasd ezt:' },
      { code: true, text: 'pnpm verify\n  --watch' },
      { code: false, text: 'Utána szólj.' },
    ])
  })

  it('runs an unclosed fence to the end, and leaves out empty pieces', () => {
    expect(textPieces('```\n<script>alert(1)</script>')).toEqual([{ code: true, text: '<script>alert(1)</script>' }])
    expect(textPieces('```\n```')).toEqual([])
  })
})

describe('the history scroll', () => {
  const box = { scrollTop: 500, clientHeight: 400, scrollHeight: 2000 }

  it('scrolls by a line, a page and to either end, within the box', () => {
    expect(peekScrollTop('ArrowDown', box)).toBe(540)
    expect(peekScrollTop('ArrowUp', box)).toBe(460)
    expect(peekScrollTop('PageDown', box)).toBe(860)
    expect(peekScrollTop('PageUp', box)).toBe(140)
    expect(peekScrollTop('Home', box)).toBe(0)
    expect(peekScrollTop('End', box)).toBe(1600)
    expect(peekScrollTop('PageUp', { ...box, scrollTop: 100 })).toBe(0)
    expect(peekScrollTop('PageDown', { ...box, scrollTop: 1500 })).toBe(1600)
    expect(peekScrollTop('a', box)).toBeUndefined()
  })

  it('tells when the history is at its bottom', () => {
    expect(isAtBottom({ ...box, scrollTop: 1600 })).toBe(true)
    expect(isAtBottom({ ...box, scrollTop: 1597 })).toBe(true)
    expect(isAtBottom({ ...box, scrollTop: 1500 })).toBe(false)
    expect(isAtBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true)
  })
})

describe('peekRequest', () => {
  const request = (summary: string, released = false): { toolName: string; summary: string; released: boolean } => ({
    toolName: 'Bash',
    summary,
    released,
  })

  it('shows nothing while the session waits on no decision', () => {
    expect(peekRequest([])).toBeUndefined()
  })

  it('describes the request the panel would show, in the row’s words', () => {
    expect(peekRequest([request('pnpm verify')])).toEqual({ text: 'Bash: pnpm verify', badge: undefined, hint: PEEK_TEXT.decideHere })
  })

  it('skips a released request for the one behind it, and counts the ones the app can decide', () => {
    expect(peekRequest([request('git status', true), request('pnpm verify'), request('pnpm build')])).toEqual({
      text: 'Bash: pnpm verify',
      badge: '2 vár',
      hint: PEEK_TEXT.decideHere,
    })
  })

  it('sends the user to VS Code when only released requests are left', () => {
    expect(peekRequest([request('git status', true)])?.hint).toBe(PEEK_TEXT.decideInVSCode)
  })
})
