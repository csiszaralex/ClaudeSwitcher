import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '@claudeswitcher/core'
import {
  EXCLUDED_GROUP_ID,
  EXCLUDED_TEXT,
  groupArrow,
  inExcludedGroup,
  isClearFinishKey,
  isExcludeKey,
  keptRows,
  listView,
  selectionAfterChange,
  showsExcludedTag,
  showsFinishMark,
} from './list-cleanup.js'
import type { MarkerTone } from './session-marker.js'

const key = (name: string, extra: Partial<{ repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
  key: name,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
})

describe('isClearFinishKey', () => {
  it('is a plain Backspace', () => {
    expect(isClearFinishKey(key('Backspace'))).toBe(true)
  })

  it('is not with a modifier, held down, or another key', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'repeat'] as const) {
      expect(isClearFinishKey(key('Backspace', { [modifier]: true }))).toBe(false)
    }
    for (const other of ['Delete', 'b', ' ', 'Enter']) expect(isClearFinishKey(key(other))).toBe(false)
  })
})

describe('showsFinishMark', () => {
  const SESSION = { sessionId: '6f1c2a3e-0000-4000-8000-000000000041' }
  const row = (tone: MarkerTone) => ({ session: SESSION, marker: { tone } })

  it('is true for the green and the blue ✓', () => {
    expect(showsFinishMark(row('done'))).toBe(true)
    expect(showsFinishMark(row('seen'))).toBe(true)
  })

  it('is false for every other marker, the usage limit included', () => {
    for (const tone of ['waiting', 'choice', 'released', 'working', 'waits-on', 'limit', 'idle'] as const) {
      expect(showsFinishMark(row(tone))).toBe(false)
    }
  })

  it('is false for a row without a session', () => {
    expect(showsFinishMark({ session: undefined, marker: { tone: 'done' } })).toBe(false)
  })
})

describe('isExcludeKey', () => {
  it('is a plain Delete', () => {
    expect(isExcludeKey(key('Delete'))).toBe(true)
  })

  it('is not with a modifier, held down, or another key', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'repeat'] as const) {
      expect(isExcludeKey(key('Delete', { [modifier]: true }))).toBe(false)
    }
    for (const other of ['Backspace', 'd', 'Del', 'Enter']) expect(isExcludeKey(key(other))).toBe(false)
  })
})

describe('groupArrow', () => {
  it('opens the closed group from its header with →, and closes the open one with ←', () => {
    expect(groupArrow(key('ArrowRight'), 'header', false)).toBe('open')
    expect(groupArrow(key('ArrowLeft'), 'header', true)).toBe('close')
  })

  it('takes ← on a row of the open group to the header first', () => {
    expect(groupArrow(key('ArrowLeft'), 'group-row', true)).toBe('to-header')
  })

  it('does nothing otherwise: → on an open header or a row, ← on a closed header or outside the group', () => {
    expect(groupArrow(key('ArrowRight'), 'header', true)).toBeUndefined()
    expect(groupArrow(key('ArrowRight'), 'group-row', true)).toBeUndefined()
    expect(groupArrow(key('ArrowLeft'), 'header', false)).toBeUndefined()
    expect(groupArrow(key('ArrowLeft'), 'other', true)).toBeUndefined()
    expect(groupArrow(key('ArrowRight'), 'other', false)).toBeUndefined()
  })

  it('acts once on a held arrow, and not with a modifier', () => {
    expect(groupArrow(key('ArrowLeft', { repeat: true }), 'group-row', true)).toBeUndefined()
    expect(groupArrow(key('ArrowLeft', { repeat: true }), 'header', true)).toBeUndefined()
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) {
      expect(groupArrow(key('ArrowRight', { [modifier]: true }), 'header', false)).toBeUndefined()
    }
  })
})

describe('the excluded group', () => {
  // Invented session ids in the registry's UUID shape.
  const A = '6f1c2a3e-0000-4000-8000-000000000081'
  const B = '6f1c2a3e-0000-4000-8000-000000000082'
  const C = '6f1c2a3e-0000-4000-8000-000000000083'
  const D = '6f1c2a3e-0000-4000-8000-000000000084'
  const row = (sessionId: string, name: string, extra: { status?: SessionStatus; decisions?: unknown[]; session?: boolean } = {}) => ({
    sessionId,
    name,
    status: extra.status ?? 'idle',
    decisions: extra.decisions ?? [],
    session: extra.session === false ? undefined : { name, cwd: `p:\\proj\\${name}` },
  })

  it('takes an excluded session that waits for nothing', () => {
    expect(inExcludedGroup(row(A, 'alpha'), new Set([A]))).toBe(true)
    expect(inExcludedGroup(row(A, 'alpha', { status: 'working' }), new Set([A]))).toBe(true)
    expect(inExcludedGroup(row(A, 'alpha'), new Set([B]))).toBe(false)
  })

  it('never takes a session with a pending request or a wait: it stays in the list with the tag', () => {
    const excluded = new Set([A])
    for (const waiting of [row(A, 'alpha', { status: 'waiting', decisions: [{}] }), row(A, 'alpha', { decisions: [{}] }), row(A, 'alpha', { status: 'waiting' })]) {
      expect(inExcludedGroup(waiting, excluded)).toBe(false)
      expect(showsExcludedTag(waiting, excluded)).toBe(true)
    }
    expect(showsExcludedTag(row(A, 'alpha'), excluded)).toBe(false)
    expect(showsExcludedTag(row(B, 'beta', { decisions: [{}] }), excluded)).toBe(false)
  })

  it('never takes a row without a session', () => {
    const orphan = row(A, 'alpha', { session: false })
    expect(inExcludedGroup(orphan, new Set([A]))).toBe(false)
    expect(showsExcludedTag(orphan, new Set([A]))).toBe(false)
  })

  it('lists the kept rows, then the header, then the rows of the open group, in their order', () => {
    const rows = [row(A, 'alpha'), row(B, 'beta'), row(C, 'gamma'), row(D, 'delta', { decisions: [{}] })]
    const excluded = new Set([B, C, D])
    expect(keptRows(rows, excluded).map((r) => r.sessionId)).toEqual([A, D])
    const closed = listView(rows, excluded, undefined, false)
    expect(closed.ids).toEqual([A, D, EXCLUDED_GROUP_ID])
    expect(closed.group.map((r) => r.sessionId)).toEqual([B, C])
    expect(closed.groupShown).toBe(true)
    expect(closed.groupOpen).toBe(false)
    expect(listView(rows, excluded, undefined, true).ids).toEqual([A, D, EXCLUDED_GROUP_ID, B, C])
  })

  it('shows no header without a row in the group', () => {
    const view = listView([row(A, 'alpha'), row(B, 'beta', { decisions: [{}] })], new Set([B]), undefined, true)
    expect(view.groupShown).toBe(false)
    expect(view.groupOpen).toBe(false)
    expect(view.ids).toEqual([A, B])
  })

  it('searches only the kept rows, and hides the group while the search is open', () => {
    const rows = [row(A, 'alpha'), row(B, 'alpine'), row(C, 'altitude', { decisions: [{}] })]
    const view = listView(rows, new Set([B, C]), 'al', true)
    expect(view.rows.map((r) => r.sessionId)).toEqual([A, C])
    expect(view.groupShown).toBe(false)
    expect(view.ids).toEqual([A, C])
  })

  it('names the header with the number of its rows', () => {
    expect(EXCLUDED_TEXT.group(3)).toBe('Kizárt (3)')
  })
})

describe('selectionAfterChange', () => {
  const H = EXCLUDED_GROUP_ID

  it('keeps a selection on another row while it is listed', () => {
    expect(selectionAfterChange(['a', 'b', H], ['a', H], 'a', 'b')).toBe('a')
    expect(selectionAfterChange(['a', 'b', H], ['b', 'a', H], 'a', 'b')).toBe('a')
    expect(selectionAfterChange(['a'], [], undefined, 'a')).toBeUndefined()
  })

  it('goes to the next row after Delete, so a second Delete acts on what is selected then', () => {
    expect(selectionAfterChange(['a', 'b', 'c'], ['a', 'c', H], 'b', 'b')).toBe('c')
  })

  it('does not follow the row into the open group: a second Delete does not bring it back', () => {
    expect(selectionAfterChange(['a', 'b', 'c', H, 'x'], ['a', 'c', H, 'b', 'x'], 'b', 'b')).toBe('c')
  })

  it('goes to the header after the last row above it: a second Delete then does nothing', () => {
    expect(selectionAfterChange(['a', 'b', H], ['a', H], 'b', 'b')).toBe(H)
    expect(selectionAfterChange(['a', 'b', H, 'x'], ['a', H, 'b', 'x'], 'b', 'b')).toBe(H)
  })

  it('goes to the next row of the open group when a row is brought back, else the one before', () => {
    expect(selectionAfterChange(['a', H, 'x', 'y'], ['a', 'x', H, 'y'], 'x', 'x')).toBe('y')
    expect(selectionAfterChange(['a', H, 'x', 'y'], ['a', 'y', H, 'x'], 'y', 'y')).toBe('x')
    expect(selectionAfterChange(['a', H, 'x'], ['a', 'x'], 'x', 'x')).toBe('a')
  })

  it('stays on a tagged row brought back: it stays in the list', () => {
    expect(selectionAfterChange(['a', 'b', H, 'x'], ['a', 'b', H, 'x'], 'b', 'b')).toBe('b')
  })

  it('stays on a row the main process did not move (a session that ended meanwhile)', () => {
    expect(selectionAfterChange(['a', 'b', H], ['a', 'b', H], 'b', 'b')).toBe('b')
  })

  it('goes to the nearest one before when nothing after it is listed', () => {
    expect(selectionAfterChange(['a', 'b'], ['a'], 'b', 'b')).toBe('a')
    expect(selectionAfterChange(['a'], [], 'a', 'a')).toBeUndefined()
  })

  it('leaves a selection it does not know', () => {
    expect(selectionAfterChange(['a'], ['a'], 'z', 'a')).toBe('z')
  })
})
