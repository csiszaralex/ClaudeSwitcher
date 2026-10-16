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

  it('defaults decisions to an empty list when an older daemon omits them', () => {
    expect(sanitizeState({ sessions: [], rateLimits: {} })?.decisions).toEqual([])
  })
})
