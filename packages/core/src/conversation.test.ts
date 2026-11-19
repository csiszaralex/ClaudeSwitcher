import { describe, expect, it } from 'vitest'
import { CONVERSATION_ENTRY_MAX, CONVERSATION_TURNS, conversationFromLines, countTurnStarts, mayBeConversation } from './conversation.js'

// Invented records in the measured shapes (Claude Code 2.1.325, design doc "The conversation"):
// the ids, pipes, names and texts are made up.
const base = { sessionId: '5b8c1e2a-7d4f-4a3b-9c6e-1f2a3b4c5d6e', timestamp: '2026-11-19T09:00:00.000Z' }
const PIPE = String.raw`\\.\pipe\LOCAL\cc-msg-11aa22bb33cc44dd55ee66ff77889900`

const line = (rec: Record<string, unknown>): string => JSON.stringify({ ...base, ...rec })
const prompt = (content: unknown): string =>
  line({ type: 'user', message: { role: 'user', content }, origin: { kind: 'human' }, promptId: 'p-1' })
const answer = (...content: unknown[]): string =>
  line({ type: 'assistant', message: { model: 'claude-x', role: 'assistant', stop_reason: 'end_turn', content } })
const toolResult = line({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'kimenet' }] },
  toolUseResult: { stdout: 'kimenet' },
})
const peerOrigin = (from: string, name: string, body: string): Record<string, unknown> => ({
  kind: 'peer',
  from,
  msg_id: '0f1e2d3c-4b5a-4697-8a8b-9c0d1e2f3a4b',
  name,
  fromMode: 'prompting',
  body,
})
const delivered = (body: string): string =>
  line({
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: `Előszó.\n<cross-session-message from="uds:${PIPE}" from-name="Karmester">\n${body}` },
    origin: peerOrigin(`uds:${PIPE}`, 'Karmester', body),
  })
const queued = (holder: Record<string, unknown>): string =>
  line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', ...holder } })

describe('conversationFromLines', () => {
  it('shows a prompt, the answer and a tool call in file order, with the tool detail', () => {
    const lines = [
      prompt('Futtasd a teszteket.'),
      answer({ type: 'thinking', thinking: 'titok', signature: 'x' }),
      answer({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm verify' } }),
      toolResult,
      answer({ type: 'text', text: '\nMinden zöld.\n' }),
    ]
    expect(conversationFromLines(lines)).toEqual([
      { kind: 'prompt', text: 'Futtasd a teszteket.', images: 0, truncated: false },
      { kind: 'tool', name: 'Bash', detail: 'pnpm verify' },
      { kind: 'answer', text: 'Minden zöld.', truncated: false },
    ])
  })

  it('reads a prompt of blocks without the IDE context, and counts its images', () => {
    const lines = [
      prompt([
        { type: 'text', text: '<ide_opened_file>The user opened the file p:\\proj\\alpha\\a.ts in the IDE.</ide_opened_file>' },
        { type: 'text', text: 'Mi ez a fájl?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'És ez?' },
      ]),
    ]
    expect(conversationFromLines(lines)).toEqual([{ kind: 'prompt', text: 'Mi ez a fájl?\n\nÉs ez?', images: 1, truncated: false }])
  })

  it('keeps a prompt that is only an image, and drops one that is only context', () => {
    const onlyImage = prompt([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }])
    const onlyContext = prompt([{ type: 'text', text: '<ide_selection>x</ide_selection>' }])
    expect(conversationFromLines([onlyImage, onlyContext])).toEqual([{ kind: 'prompt', text: '', images: 1, truncated: false }])
  })

  it('shows a prompt typed while the session worked (a queued_command)', () => {
    const lines = [queued({ prompt: [{ type: 'text', text: 'Még ezt is.' }], origin: { kind: 'human' }, humanTurn: true })]
    expect(conversationFromLines(lines)).toEqual([{ kind: 'prompt', text: 'Még ezt is.', images: 0, truncated: false }])
  })

  it('shows a slash command short, and leaves out its caveat and output', () => {
    const lines = [
      line({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' } }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>',
        },
      }),
      line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' } }),
    ]
    expect(conversationFromLines(lines)).toEqual([{ kind: 'command', text: '/model opus' }])
  })

  it('shows a command without arguments by its name', () => {
    const lines = [line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name><command-args></command-args>' } })]
    expect(conversationFromLines(lines)).toEqual([{ kind: 'command', text: '/clear' }])
  })

  it('shows an incoming cross-session message by its body and sender, delivered either way', () => {
    const lines = [
      delivered('Nézd meg a hibát.'),
      queued({ prompt: '<cross-session-message …>\nMég egy.', origin: peerOrigin(`uds:${PIPE}`, 'Karmester', 'Még egy.') }),
    ]
    expect(conversationFromLines(lines)).toEqual([
      { kind: 'message', sender: { pipe: PIPE, name: 'Karmester' }, text: 'Nézd meg a hibát.', truncated: false },
      { kind: 'message', sender: { pipe: PIPE, name: 'Karmester' }, text: 'Még egy.', truncated: false },
    ])
  })

  it('leaves out a subagent handback, system reminders, the compact summary, task notices and other records', () => {
    const lines = [
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'Az alügynök eredménye.' },
        origin: { kind: 'peer', from: '0a1b2c3d4e5f60718', senderTaskId: 'task-1', name: 'worker', handback: true, body: 'x' },
      }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>Emlékeztető.</system-reminder>' } }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'A skill szövege.' }] } }),
      line({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'Összefoglaló.' } }),
      line({ type: 'user', message: { role: 'user', content: '<task-notification>kész</task-notification>' }, origin: { kind: 'task-notification' } }),
      queued({ prompt: '<task-notification>kész</task-notification>', commandMode: 'task-notification' }),
      line({ type: 'attachment', attachment: { type: 'date_change', newDate: '2026-11-19' } }),
      line({ type: 'system', subtype: 'turn_duration', durationMs: 1000 }),
      line({ type: 'ai-title', aiTitle: 'Cím' }),
      line({ type: 'api-request', request: {} }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Mellékszál.' }] } }),
      toolResult,
    ]
    expect(conversationFromLines(lines)).toEqual([])
  })

  it('skips broken lines and malformed records without throwing', () => {
    const lines = [
      '{"type":"user","mess',
      '',
      'null',
      '[1,2]',
      line({ type: 'user', origin: { kind: 'human' }, message: { content: 42 } }),
      line({ type: 'user', origin: { kind: 'human' }, message: 'x' }),
      line({ type: 'assistant', message: { content: [null, 7, { type: 'text', text: 7 }, { type: 'tool_use', name: 7 }, { type: 'text', text: '  ' }] } }),
      line({ type: 'user', origin: 'human', message: { content: '<command-name></command-name>' } }),
      prompt('Ez megmarad.'),
    ]
    expect(() => conversationFromLines(lines)).not.toThrow()
    expect(conversationFromLines(lines)).toEqual([{ kind: 'prompt', text: 'Ez megmarad.', images: 0, truncated: false }])
  })

  it('cuts a huge text at CONVERSATION_ENTRY_MAX and says so', () => {
    const huge = 'a'.repeat(CONVERSATION_ENTRY_MAX + 10)
    const [entry] = conversationFromLines([answer({ type: 'text', text: huge })])
    expect(entry).toEqual({ kind: 'answer', text: 'a'.repeat(CONVERSATION_ENTRY_MAX), truncated: true })
  })

  it('keeps the last maxTurns turns, from the start of the oldest one kept', () => {
    const lines = [
      answer({ type: 'text', text: 'Egy korábbi turn vége.' }),
      prompt('Első.'),
      answer({ type: 'text', text: 'Első válasz.' }),
      delivered('Második.'),
      answer({ type: 'text', text: 'Második válasz.' }),
      prompt('Harmadik.'),
    ]
    expect(conversationFromLines(lines, 2).map((entry) => entry.kind)).toEqual(['message', 'answer', 'prompt'])
    // With exactly maxTurns turns, the end of the earlier turn goes; with fewer, everything stays.
    expect(conversationFromLines(lines, 3)).toHaveLength(5)
    expect(conversationFromLines(lines, 4)).toHaveLength(6)
  })

  it('shows CONVERSATION_TURNS turns by default', () => {
    const lines = Array.from({ length: CONVERSATION_TURNS + 5 }, (_, i) => prompt(`Kérés ${String(i)}.`))
    const entries = conversationFromLines(lines)
    expect(entries).toHaveLength(CONVERSATION_TURNS)
    expect(entries[0]).toMatchObject({ text: 'Kérés 5.' })
  })
})

describe('countTurnStarts', () => {
  it('counts prompts, commands and incoming messages, not answers', () => {
    const lines = [
      prompt('Egy.'),
      answer({ type: 'text', text: 'Válasz.' }),
      line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      delivered('Kettő.'),
      toolResult,
    ]
    expect(countTurnStarts(lines)).toBe(3)
  })
})

describe('mayBeConversation', () => {
  it('passes the user, assistant and queued prompt lines, not tool results or other records', () => {
    expect(mayBeConversation(prompt('Szia.'))).toBe(true)
    expect(mayBeConversation(answer({ type: 'text', text: 'Szia.' }))).toBe(true)
    expect(mayBeConversation(queued({ prompt: 'x', origin: { kind: 'human' } }))).toBe(true)
    expect(mayBeConversation(toolResult)).toBe(false)
    expect(mayBeConversation(line({ type: 'ai-title', aiTitle: 'x' }))).toBe(false)
  })

  it('keeps a prompt whose text quotes the markers: the quotes are escaped there', () => {
    expect(mayBeConversation(prompt('Mi az a "toolUseResult" mező és a "type":"x"?'))).toBe(true)
  })
})
