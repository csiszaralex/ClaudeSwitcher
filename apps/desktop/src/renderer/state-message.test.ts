import { describe, expect, it } from 'vitest'
import { parseStateMessage, sanitizeState } from './state-message.js'
import { readFileSync } from 'node:fs'
import { parsePermissionRequest } from '@claudeswitcher/core/browser'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../../packages/core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

/** Egy függő döntés úgy, ahogy a daemon küldi: a valódi payload értelmezve, broker-mezőkkel. */
function decisionFrom(name: string): Record<string, unknown> {
  const info = parsePermissionRequest(fixtures[name])
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return { ...info, id: `id-${name}`, createdAt: 1, released: false }
}

describe('parseStateMessage', () => {
  it('returns the state carried by a well-formed state message', () => {
    const message = JSON.stringify({ type: 'state', payload: { sessions: [], rateLimits: {}, decisions: [] } })
    expect(parseStateMessage(message)).toEqual({ sessions: [], rateLimits: {}, decisions: [] })
  })

  it('ignores messages that are not state updates', () => {
    expect(parseStateMessage(JSON.stringify({ type: 'other', payload: {} }))).toBeUndefined()
    expect(parseStateMessage(JSON.stringify({ type: 'state', payload: { sessions: 'no' } }))).toBeUndefined()
  })

  it('never throws on garbage', () => {
    for (const garbage of ['not json', '', 'null', '42', '[]', undefined]) {
      expect(() => parseStateMessage(garbage)).not.toThrow()
      expect(parseStateMessage(garbage)).toBeUndefined()
    }
  })

  it('drops a malformed session instead of handing it to the renderer', () => {
    // Enélkül az App a `view.sessionId`-n dobna, és mivel az ErrorBoundary nem áll vissza
    // magától, az overlay onnantól véglegesen hibaszöveget mutatna.
    const message = JSON.stringify({
      type: 'state',
      payload: { sessions: [null, { sessionId: 'a' }, 'nope', {}], rateLimits: {} },
    })
    expect(parseStateMessage(message)?.sessions).toEqual([{ sessionId: 'a' }])
  })

  it('keeps a session carrying stoppedAt, and drops one whose stoppedAt is not a number', () => {
    // A part B ebből számol „épp végzett" állapotot; egy szöveges érték ott NaN-t adna.
    const message = JSON.stringify({
      type: 'state',
      payload: {
        sessions: [{ sessionId: 'a', stoppedAt: 5_000 }, { sessionId: 'b', stoppedAt: 'tegnap' }, { sessionId: 'c' }],
        rateLimits: {},
      },
    })
    expect(parseStateMessage(message)?.sessions).toEqual([{ sessionId: 'a', stoppedAt: 5_000 }, { sessionId: 'c' }])
  })

  it('keeps a session carrying an entrypoint string, and drops one whose entrypoint is not a string', () => {
    // Opcionális: egy régebbi daemon nem küldi. Ha jön, szövegnek kell lennie.
    const message = JSON.stringify({
      type: 'state',
      payload: {
        sessions: [
          { sessionId: 'a', entrypoint: 'claude-vscode' },
          { sessionId: 'b', entrypoint: 42 },
          { sessionId: 'c', entrypoint: null },
          { sessionId: 'd' },
        ],
        rateLimits: {},
      },
    })
    expect(parseStateMessage(message)?.sessions).toEqual([
      { sessionId: 'a', entrypoint: 'claude-vscode' },
      { sessionId: 'd' },
    ])
  })

  it('keeps a session carrying well-formed subagents, and drops one whose subagents are malformed', () => {
    // Opcionális: egy régebbi daemon nem küldi. Ha jön, minden elemének a sor által olvasott alakja kell legyen.
    const good = { agentId: 'a1', agentType: 'general-purpose', description: 'd', runningTool: 'Grep', toolDetail: 'x', updatedAt: 5 }
    const bare = { agentId: 'a2', updatedAt: 6 }
    const message = JSON.stringify({
      type: 'state',
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
        rateLimits: {},
      },
    })
    expect(parseStateMessage(message)?.sessions).toEqual([
      { sessionId: 'a', subagents: [good, bare] },
      { sessionId: 'j', subagents: [] },
      { sessionId: 'k' },
    ])
  })
})

describe('sanitizeState', () => {
  it('drops a null rate-limit window, which an undefined check would let through', () => {
    // `five_hour !== undefined` egy null-ra IGAZ, és a `.used_percentage` utána dob.
    const clean = sanitizeState({
      sessions: [],
      rateLimits: { five_hour: null, seven_day: { used_percentage: 4, resets_at: 1 } },
    })
    expect(clean?.rateLimits.five_hour).toBeUndefined()
    expect(clean?.rateLimits.seven_day).toEqual({ used_percentage: 4, resets_at: 1 })
  })

  it('rejects a payload whose containers are the wrong type', () => {
    expect(sanitizeState({ sessions: 'no', rateLimits: {} })).toBeUndefined()
    expect(sanitizeState({ sessions: [], rateLimits: null })).toBeUndefined()
    expect(sanitizeState(undefined)).toBeUndefined()
  })

  it('never throws, whatever it is handed', () => {
    for (const garbage of [null, 42, 'text', [], { sessions: [undefined], rateLimits: {} }]) {
      expect(() => sanitizeState(garbage)).not.toThrow()
    }
  })

  it('keeps a well-formed decision and drops the malformed ones', () => {
    // Egy hibás elem a panelen renderelési hibát dobna, és az ErrorBoundary miatt az egész
    // overlay hibaszövegbe fagyna — itt csendben kiesik.
    const good = decisionFrom('permissionRequest_askMulti')
    const clean = sanitizeState({
      sessions: [],
      rateLimits: {},
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
    // A panel a leírást szövegként rendereli; egy objektum ott dobna.
    const good = decisionFrom('permissionRequest_bash')
    expect(good['description']).toBe('Write spike-a to a.txt')
    const clean = sanitizeState({
      sessions: [],
      rateLimits: {},
      decisions: [good, { ...good, id: 'x', description: { text: 'nope' } }],
    })
    expect(clean?.decisions).toEqual([good])
  })

  it('keeps an unreadable decision, and drops one whose readable flag is missing or not a boolean', () => {
    // A panel ebből dönti el, kínál-e engedélyezést; egy hiányzó jelző nem számíthat olvashatónak.
    const good = decisionFrom('permissionRequest_bash')
    expect(good['readable']).toBe(true)
    const blind = { ...good, id: 'blind', readable: false }
    const missing: Record<string, unknown> = { ...good, id: 'missing' }
    delete missing['readable']
    const clean = sanitizeState({
      sessions: [],
      rateLimits: {},
      decisions: [good, blind, missing, { ...good, id: 'text', readable: 'yes' }],
    })
    expect(clean?.decisions).toEqual([good, blind])
  })

  it('defaults decisions to an empty list when an older daemon omits them', () => {
    expect(sanitizeState({ sessions: [], rateLimits: {} })?.decisions).toEqual([])
  })
})
