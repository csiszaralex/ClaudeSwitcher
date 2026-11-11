import { describe, expect, it } from 'vitest'
import { parseDaemonMessage, sanitizeState } from './state-message.js'
import { DAEMON_PROTOCOL } from '@claudeswitcher/core/browser'
import { parsedPayload } from '@claudeswitcher/core/testing'

/** A pending decision as the daemon sends it: the real payload parsed, with the broker's fields. */
function decisionFrom(name: string): Record<string, unknown> {
  return { ...parsedPayload(name), id: `id-${name}`, createdAt: 1, released: false }
}

/** The sessions of a state message, or `undefined` when it is not one. */
function sessionsOf(data: unknown): unknown[] | undefined {
  const parsed = parseDaemonMessage(data)
  return parsed?.kind === 'state' ? parsed.state.sessions : undefined
}

describe('parseDaemonMessage state messages', () => {
  it('returns the state carried by a well-formed state message', () => {
    const message = JSON.stringify({ type: 'state', protocol: DAEMON_PROTOCOL, payload: { sessions: [], decisions: [] } })
    expect(parseDaemonMessage(message)).toEqual({ kind: 'state', state: { sessions: [], decisions: [] } })
  })

  it('ignores messages that are not state updates', () => {
    expect(parseDaemonMessage(JSON.stringify({ type: 'other', payload: {} }))).toBeUndefined()
    expect(parseDaemonMessage(JSON.stringify({ type: 'state', protocol: DAEMON_PROTOCOL, payload: { sessions: 'no' } }))).toBeUndefined()
  })

  it('never throws on garbage', () => {
    for (const garbage of ['not json', '', 'null', '42', '[]', undefined]) {
      expect(() => parseDaemonMessage(garbage)).not.toThrow()
      expect(parseDaemonMessage(garbage)).toBeUndefined()
    }
  })

  it('drops a malformed session instead of handing it to the renderer', () => {
    // Without this App would throw on `view.sessionId`, and the ErrorBoundary would show an error
    // text instead of the list until a state without the bad element arrives.
    const message = JSON.stringify({
      type: 'state',
      protocol: DAEMON_PROTOCOL,
      payload: { sessions: [null, { sessionId: 'a' }, 'nope', {}] },
    })
    expect(sessionsOf(message)).toEqual([{ sessionId: 'a' }])
  })

  it('keeps a session carrying stoppedAt, and drops one whose stoppedAt is not a number', () => {
    // The status marker shows "just finished" from it (session-marker.ts `statusMarker`); the field
    // must keep the number type `SessionView` declares.
    const message = JSON.stringify({
      type: 'state',
      protocol: DAEMON_PROTOCOL,
      payload: {
        sessions: [{ sessionId: 'a', stoppedAt: 5_000 }, { sessionId: 'b', stoppedAt: 'tegnap' }, { sessionId: 'c' }],
      },
    })
    expect(sessionsOf(message)).toEqual([{ sessionId: 'a', stoppedAt: 5_000 }, { sessionId: 'c' }])
  })

  it('keeps a session carrying an entrypoint string, and drops one whose entrypoint is not a string', () => {
    // Optional in `SessionView` (it comes from the registry record when there is one). If present it must be a string.
    const message = JSON.stringify({
      type: 'state',
      protocol: DAEMON_PROTOCOL,
      payload: {
        sessions: [
          { sessionId: 'a', entrypoint: 'claude-vscode' },
          { sessionId: 'b', entrypoint: 42 },
          { sessionId: 'c', entrypoint: null },
          { sessionId: 'd' },
        ],
      },
    })
    expect(sessionsOf(message)).toEqual([
      { sessionId: 'a', entrypoint: 'claude-vscode' },
      { sessionId: 'd' },
    ])
  })

  it('keeps a session carrying well-formed subagents, and drops one whose subagents are malformed', () => {
    // Optional in `SessionView` (present only with an active subagent). If present, every element
    // must have the shape the row reads.
    const good = { agentId: 'a1', agentType: 'general-purpose', description: 'd', runningTool: 'Grep', toolDetail: 'x', updatedAt: 5 }
    const bare = { agentId: 'a2', updatedAt: 6 }
    const message = JSON.stringify({
      type: 'state',
      protocol: DAEMON_PROTOCOL,
      payload: {
        sessions: [
          { sessionId: 'a', subagents: [good, bare] },
          { sessionId: 'b', subagents: 'sok' },
          { sessionId: 'c', subagents: [null] },
          { sessionId: 'd', subagents: [{ ...good, agentId: 7 }] },
          { sessionId: 'e', subagents: [{ ...good, updatedAt: 'most' }] },
          { sessionId: 'f', subagents: [{ ...good, runningTool: 3 }] },
          { sessionId: 'g', subagents: [{ ...good, toolDetail: {} }] },
          { sessionId: 'h', subagents: [{ ...good, description: null }] },
          { sessionId: 'i', subagents: [{ ...good, agentType: false }] },
          { sessionId: 'j', subagents: [] },
          { sessionId: 'k' },
        ],
      },
    })
    expect(sessionsOf(message)).toEqual([
      { sessionId: 'a', subagents: [good, bare] },
      { sessionId: 'j', subagents: [] },
      { sessionId: 'k' },
    ])
  })
})

describe('sanitizeState', () => {
  it('rejects a payload whose containers are the wrong type', () => {
    expect(sanitizeState({ sessions: 'no' })).toBeUndefined()
    expect(sanitizeState(undefined)).toBeUndefined()
  })

  it('never throws, whatever it is handed', () => {
    for (const garbage of [null, 42, 'text', [], { sessions: [undefined] }]) {
      expect(() => sanitizeState(garbage)).not.toThrow()
    }
  })

  it('keeps a well-formed decision and drops the malformed ones', () => {
    // A bad element would throw a render error in the panel, and an ErrorBoundary would replace it
    // with an error text: here it silently drops out.
    const good = decisionFrom('permissionRequest_askMulti')
    const clean = sanitizeState({
      sessions: [],
      decisions: [
        good,
        null,
        { ...good, id: 7 },
        { ...good, kind: 'other' },
        { ...good, questions: [{ question: 'q' }] },
        { ...good, suggestedRules: [{}] },
      ],
    })
    expect(clean?.decisions).toEqual([good])
  })

  it('keeps a decision carrying a description, and drops one whose description is not a string', () => {
    // The panel renders the description as text; an object would throw there.
    const good = decisionFrom('permissionRequest_bash')
    expect(good['description']).toBe('Write spike-a to a.txt')
    const clean = sanitizeState({
      sessions: [],
      decisions: [good, { ...good, id: 'x', description: { text: 'nope' } }],
    })
    expect(clean?.decisions).toEqual([good])
  })

  it('keeps an unreadable decision, and drops one whose readable flag is missing or not a boolean', () => {
    // From it the panel decides whether to offer allowing; a missing flag must not count as readable.
    const good = decisionFrom('permissionRequest_bash')
    expect(good['readable']).toBe(true)
    const blind = { ...good, id: 'blind', readable: false }
    const missing: Record<string, unknown> = { ...good, id: 'missing' }
    delete missing['readable']
    const clean = sanitizeState({
      sessions: [],
      decisions: [good, blind, missing, { ...good, id: 'text', readable: 'yes' }],
    })
    expect(clean?.decisions).toEqual([good, blind])
  })

  it('drops a field it does not know, such as the retired rateLimits', () => {
    expect(sanitizeState({ sessions: [], rateLimits: { five_hour: null }, decisions: [] })).toEqual({
      sessions: [],
      decisions: [],
    })
  })

  it('rejects an array where an object is expected, even one carrying the right named fields', () => {
    // A deliberate change: the renderer's former `isObject` accepted an array too, the other guards
    // did not. Such an array cannot come from JSON, but the IPC path gives `unknown`, and the guard
    // should be the same everywhere.
    const arraySession = Object.assign([], { sessionId: 'array' })
    const arrayDecision = Object.assign([], decisionFrom('permissionRequest_bash'))
    const clean = sanitizeState({ sessions: [arraySession, { sessionId: 'a' }], decisions: [arrayDecision] })
    expect(clean?.sessions).toEqual([{ sessionId: 'a' }])
    expect(clean?.decisions).toEqual([])
    expect(sanitizeState(Object.assign([], { sessions: [] }))).toBeUndefined()
  })

  it('defaults decisions to an empty list when the payload omits them', () => {
    expect(sanitizeState({ sessions: [] })?.decisions).toEqual([])
  })
})

describe('parseDaemonMessage protocol', () => {
  it('accepts state and tick messages of the current protocol', () => {
    const state = JSON.stringify({ type: 'state', protocol: DAEMON_PROTOCOL, payload: { sessions: [] } })
    expect(parseDaemonMessage(state)).toEqual({ kind: 'state', state: { sessions: [], decisions: [] } })
    expect(parseDaemonMessage(JSON.stringify({ type: 'tick', protocol: DAEMON_PROTOCOL, at: 1 }))).toEqual({ kind: 'tick' })
  })

  it('rejects a message without the protocol field or with another version', () => {
    for (const protocol of [undefined, 0, DAEMON_PROTOCOL + 1, String(DAEMON_PROTOCOL), null]) {
      const state = JSON.stringify({ type: 'state', protocol, payload: { sessions: [], decisions: [] } })
      expect(parseDaemonMessage(state)).toBeUndefined()
      expect(parseDaemonMessage(JSON.stringify({ type: 'tick', protocol, at: 1 }))).toBeUndefined()
    }
  })
})
