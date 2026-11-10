import { describe, expect, it } from 'vitest'
import type { SessionStatus as Status } from '@claudeswitcher/core'
import { TYPING_COOLDOWN_MS } from './key-guard.js'
import {
  moveSelection,
  nextAfterDecision,
  resolveSelectedIndex,
  selectOnArrival,
  selectOnShow,
  trackArrivals,
} from './selection.js'

const view = (sessionId: string, status: Status): { sessionId: string; status: Status } => ({ sessionId, status })
const pending = (
  id: string,
  sessionId: string,
  released = false,
): { id: string; sessionId: string; released: boolean } => ({ id, sessionId, released })

describe('resolveSelectedIndex', () => {
  it('returns -1 for an empty list', () => {
    expect(resolveSelectedIndex([], 'a')).toBe(-1)
  })

  it('defaults to the first session when nothing is selected', () => {
    expect(resolveSelectedIndex(['a', 'b'], undefined)).toBe(0)
  })

  it('follows the selected session when the list re-sorts', () => {
    // `b` was at index 1; a `c` that starts waiting jumps to the top. Tracking by index, Enter
    // would now jump to `a`'s window.
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
    // Before the fix this set the selection to -1, where it got stuck.
    expect(moveSelection([], undefined, 1)).toBeUndefined()
  })
})

describe('selectOnShow', () => {
  it('selects the first waiting session: the daemon sorts the oldest wait first', () => {
    const sessions = [view('w1', 'waiting'), view('w2', 'waiting'), view('i', 'idle')]
    expect(selectOnShow(sessions, [], 'i')).toBe('w1')
  })

  it('counts a session with a held decision as waiting even if its status lags', () => {
    // The two pieces of data come in separate parts of the message; a held decision asks for attention regardless.
    expect(selectOnShow([view('a', 'idle'), view('b', 'working')], [pending('d1', 'b')], 'a')).toBe('b')
  })

  it('does not jump to a session whose decisions are all released while another one waits', () => {
    // Because of `#pending` the daemon shows a session with a released request as `waiting` too,
    // and sorts it first: so the status must not lift it back to tier 1.
    const sessions = [view('r', 'waiting'), view('w', 'waiting')]
    expect(selectOnShow(sessions, [pending('d1', 'r', true), pending('d2', 'w')], 'w')).toBe('w')
  })

  it('counts a waiting session without any held decision (Notification wait)', () => {
    const sessions = [view('r', 'waiting'), view('n', 'waiting')]
    expect(selectOnShow(sessions, [pending('d1', 'r', true)], undefined)).toBe('n')
  })

  it('counts a session with a released and a still held decision as waiting', () => {
    const sessions = [view('x', 'idle'), view('m', 'waiting')]
    expect(selectOnShow(sessions, [pending('d1', 'm', true), pending('d2', 'm')], undefined)).toBe('m')
  })

  it('falls back to a released session only when nothing else waits, in list order', () => {
    const sessions = [view('r1', 'waiting'), view('r2', 'waiting'), view('i', 'idle')]
    const decisions = [pending('d1', 'r1', true), pending('d2', 'r2', true)]
    expect(selectOnShow(sessions, decisions, 'i')).toBe('r1')
  })

  it('keeps the current selection when nothing is waiting', () => {
    expect(selectOnShow([view('a', 'idle'), view('b', 'working')], [], 'b')).toBe('b')
    expect(selectOnShow([view('a', 'idle')], [], undefined)).toBeUndefined()
  })
})

describe('nextAfterDecision', () => {
  it('moves to the first waiting session other than the decided one', () => {
    // The session just decided can still be "waiting" in the state if the broadcast comes after the
    // decision's reply: so it is excluded instead of waiting for the state.
    const sessions = [view('a', 'waiting'), view('b', 'waiting'), view('c', 'idle')]
    const decisions = [pending('da', 'a'), pending('db', 'b')]
    expect(nextAfterDecision(sessions, decisions, pending('da', 'a'), true)).toEqual({ select: 'b', hide: false })
  })

  it('does not hide while another session still waits, even with auto-hide on', () => {
    const sessions = [view('a', 'idle'), view('n', 'waiting')]
    expect(nextAfterDecision(sessions, [], pending('da', 'a'), true)).toEqual({ select: 'n', hide: false })
  })

  it('stays on the decided session when it has another held decision', () => {
    // Parallel tool calls: the same session can have several pending requests. Then the overlay
    // must not hide, and the next request is right here.
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

  it('does not stay for a released sibling of the decided session', () => {
    const sessions = [view('a', 'waiting'), view('b', 'waiting')]
    const decisions = [pending('d1', 'a'), pending('d2', 'a', true), pending('d3', 'b')]
    expect(nextAfterDecision(sessions, decisions, pending('d1', 'a'), true)).toEqual({ select: 'b', hide: false })
  })

  it('skips a released-only session in favour of one that can be decided', () => {
    const sessions = [view('r', 'waiting'), view('a', 'waiting'), view('w', 'waiting')]
    const decisions = [pending('dr', 'r', true), pending('da', 'a'), pending('dw', 'w')]
    expect(nextAfterDecision(sessions, decisions, pending('da', 'a'), true)).toEqual({ select: 'w', hide: false })
  })

  it('moves to a released-only session when nothing else waits, without hiding', () => {
    const sessions = [view('a', 'waiting'), view('r', 'waiting')]
    const decisions = [pending('da', 'a'), pending('dr', 'r', true)]
    expect(nextAfterDecision(sessions, decisions, pending('da', 'a'), true)).toEqual({ select: 'r', hide: false })
  })
})

describe('selectOnArrival', () => {
  const NOW = 100_000
  const calm = { lastTypedAt: undefined, now: NOW }

  it('jumps to a new decidable request when the selected row holds no decision', () => {
    const sessions = [view('a', 'idle'), view('b', 'waiting')]
    expect(
      selectOnArrival({ sessions, decisions: [pending('db', 'b')], known: new Set(), selectedId: 'a', ...calm }),
    ).toBe('b')
  })

  it('stays when nothing new arrived', () => {
    const sessions = [view('a', 'idle'), view('b', 'waiting')]
    expect(
      selectOnArrival({ sessions, decisions: [pending('db', 'b')], known: new Set(['db']), selectedId: 'a', ...calm }),
    ).toBeUndefined()
  })

  it('never pulls the selection away from a row with a held decision, the user is reading it', () => {
    const sessions = [view('a', 'waiting'), view('b', 'waiting')]
    const decisions = [pending('da', 'a'), pending('db', 'b')]
    expect(selectOnArrival({ sessions, decisions, known: new Set(['da']), selectedId: 'a', ...calm })).toBeUndefined()
  })

  it('stays on a row whose held decision is released too', () => {
    const sessions = [view('a', 'waiting'), view('b', 'waiting')]
    const decisions = [pending('da', 'a', true), pending('db', 'b')]
    expect(selectOnArrival({ sessions, decisions, known: new Set(['da']), selectedId: 'a', ...calm })).toBeUndefined()
  })

  it('stays while the user typed within TYPING_COOLDOWN_MS, and jumps after it', () => {
    const sessions = [view('a', 'idle'), view('b', 'waiting')]
    const input = { sessions, decisions: [pending('db', 'b')], known: new Set<string>(), selectedId: 'a' }
    expect(selectOnArrival({ ...input, lastTypedAt: NOW - TYPING_COOLDOWN_MS + 1, now: NOW })).toBeUndefined()
    expect(selectOnArrival({ ...input, lastTypedAt: NOW - TYPING_COOLDOWN_MS, now: NOW })).toBe('b')
  })

  it('never jumps to a released request', () => {
    const sessions = [view('a', 'idle'), view('r', 'waiting')]
    expect(
      selectOnArrival({ sessions, decisions: [pending('dr', 'r', true)], known: new Set(), selectedId: 'a', ...calm }),
    ).toBeUndefined()
  })

  it('picks the first row in list order when several requests arrive together', () => {
    const sessions = [view('a', 'idle'), view('c', 'waiting'), view('b', 'waiting')]
    const decisions = [pending('db', 'b'), pending('dc', 'c')]
    expect(selectOnArrival({ sessions, decisions, known: new Set(), selectedId: 'a', ...calm })).toBe('c')
  })

  it('jumps from a row that waits outside the app (no held decision)', () => {
    const sessions = [view('n', 'waiting'), view('b', 'waiting')]
    expect(
      selectOnArrival({ sessions, decisions: [pending('db', 'b')], known: new Set(), selectedId: 'n', ...calm }),
    ).toBe('b')
  })
})

describe('trackArrivals', () => {
  const calm = { lastTypedAt: undefined, now: 100_000 }

  it('jumps once per new request: the same state again does not move the selection', () => {
    const track = trackArrivals()
    const sessions = [view('a', 'idle'), view('b', 'waiting')]
    expect(track({ sessions, decisions: [], selectedId: 'a', ...calm })).toBeUndefined()
    expect(track({ sessions, decisions: [pending('db', 'b')], selectedId: 'a', ...calm })).toBe('b')
    // The user stepped back to `a`: the same request does not pull the selection away again.
    expect(track({ sessions, decisions: [pending('db', 'b')], selectedId: 'a', ...calm })).toBeUndefined()
  })

  it('does not jump later to a request that arrived while it had to stay', () => {
    const track = trackArrivals()
    const sessions = [view('a', 'waiting'), view('b', 'waiting')]
    expect(track({ sessions, decisions: [pending('da', 'a')], selectedId: 'a', ...calm })).toBe(undefined)
    expect(track({ sessions, decisions: [pending('da', 'a'), pending('db', 'b')], selectedId: 'a', ...calm })).toBeUndefined()
    // `a`'s request was settled: `b` is no longer new, so the selection does not jump to it afterwards.
    expect(track({ sessions, decisions: [pending('db', 'b')], selectedId: 'a', ...calm })).toBeUndefined()
  })
})
