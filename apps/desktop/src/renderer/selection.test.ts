import { describe, expect, it } from 'vitest'
import { moveSelection, nextAfterDecision, resolveSelectedIndex, selectOnShow } from './selection.js'

type Status = 'waiting' | 'working' | 'idle' | 'unknown'
const view = (sessionId: string, status: Status): { sessionId: string; status: Status } => ({ sessionId, status })
const pending = (id: string, sessionId: string): { id: string; sessionId: string } => ({ id, sessionId })

describe('resolveSelectedIndex', () => {
  it('returns -1 for an empty list', () => {
    expect(resolveSelectedIndex([], 'a')).toBe(-1)
  })

  it('defaults to the first session when nothing is selected', () => {
    expect(resolveSelectedIndex(['a', 'b'], undefined)).toBe(0)
  })

  it('follows the selected session when the list re-sorts', () => {
    // A `b` az 1-es indexen volt; egy várakozni kezdő `c` felülre ugrik. Index
    // szerinti követéssel az Enter most az `a` ablakára ugrana.
    expect(resolveSelectedIndex(['c', 'a', 'b'], 'b')).toBe(2)
  })

  it('falls back to the first session when the selected one disappears', () => {
    expect(resolveSelectedIndex(['a', 'c'], 'b')).toBe(0)
  })
})

describe('moveSelection', () => {
  it('moves down and up by session, not by stale index', () => {
    expect(moveSelection(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(moveSelection(['a', 'b', 'c'], 'c', -1)).toBe('b')
  })

  it('stops at both ends of the list', () => {
    expect(moveSelection(['a', 'b'], 'b', 1)).toBe('b')
    expect(moveSelection(['a', 'b'], 'a', -1)).toBe('a')
  })

  it('returns undefined for an empty list rather than an invalid position', () => {
    // A javítás előtt ez a kiválasztást -1-re állította, ahol beragadt.
    expect(moveSelection([], undefined, 1)).toBeUndefined()
  })
})

describe('selectOnShow', () => {
  it('selects the first waiting session — the daemon sorts the oldest wait first', () => {
    const sessions = [view('w1', 'waiting'), view('w2', 'waiting'), view('i', 'idle')]
    expect(selectOnShow(sessions, [], 'i')).toBe('w1')
  })

  it('counts a session with a held decision as waiting even if its status lags', () => {
    // A két adat külön üzenetrészben jön; egy tartott döntés mindenképp figyelmet kér.
    expect(selectOnShow([view('a', 'idle'), view('b', 'working')], [pending('d1', 'b')], 'a')).toBe('b')
  })

  it('keeps the current selection when nothing is waiting', () => {
    expect(selectOnShow([view('a', 'idle'), view('b', 'working')], [], 'b')).toBe('b')
    expect(selectOnShow([view('a', 'idle')], [], undefined)).toBeUndefined()
  })
})

describe('nextAfterDecision', () => {
  it('moves to the first waiting session other than the decided one', () => {
    // A frissen eldöntött session az állapotban még „waiting" lehet, ha a broadcast a döntés
    // válasza után jön — ezért kizárjuk, nem az állapotra várunk.
    const sessions = [view('a', 'waiting'), view('b', 'waiting'), view('c', 'idle')]
    const decisions = [pending('da', 'a'), pending('db', 'b')]
    expect(nextAfterDecision(sessions, decisions, pending('da', 'a'), true)).toEqual({ select: 'b', hide: false })
  })

  it('does not hide while another session still waits, even with auto-hide on', () => {
    const sessions = [view('a', 'idle'), view('n', 'waiting')]
    expect(nextAfterDecision(sessions, [], pending('da', 'a'), true)).toEqual({ select: 'n', hide: false })
  })

  it('stays on the decided session when it has another held decision', () => {
    // Párhuzamos tool-hívások: ugyanannak a sessionnek több kérése is függhet. Ilyenkor
    // nem szabad elrejtőzni, és a következő kérés ugyanitt van.
    const sessions = [view('a', 'waiting'), view('b', 'waiting')]
    const decisions = [pending('d1', 'a'), pending('d2', 'a'), pending('d3', 'b')]
    expect(nextAfterDecision(sessions, decisions, pending('d1', 'a'), true)).toEqual({ select: 'a', hide: false })
  })

  it('hides after the last waiting session when auto-hide is on', () => {
    const sessions = [view('a', 'waiting'), view('b', 'idle')]
    expect(nextAfterDecision(sessions, [pending('da', 'a')], pending('da', 'a'), true)).toEqual({ hide: true })
  })

  it('stays open after the last waiting session when auto-hide is off', () => {
    const sessions = [view('a', 'waiting'), view('b', 'idle')]
    expect(nextAfterDecision(sessions, [pending('da', 'a')], pending('da', 'a'), false)).toEqual({ hide: false })
  })
})
