import { describe, expect, it } from 'vitest'
import type { SessionStatus as Status } from '@claudeswitcher/core'
import { hasRemoteControl, statusMarker } from './session-marker.js'

const session = (status: Status, stoppedAt?: number): { status: Status; stoppedAt?: number | undefined } => ({
  status,
  stoppedAt,
})

describe('statusMarker', () => {
  it('shows a held decision as waiting for a reply', () => {
    expect(statusMarker(session('waiting'), [{ released: false }]).tone).toBe('waiting')
  })

  it('shows a Notification wait (no held decision) as waiting too', () => {
    expect(statusMarker(session('waiting'), []).tone).toBe('waiting')
  })

  it('shows a released decision differently: only VS Code or the phone can answer it now', () => {
    expect(statusMarker(session('waiting'), [{ released: true }]).tone).toBe('released')
  })

  it('prefers a still-held decision over a released one of the same session', () => {
    // Amíg van az appból eldönthető kérés, az a fontosabb jel.
    expect(statusMarker(session('waiting'), [{ released: true }, { released: false }]).tone).toBe('waiting')
  })

  it('shows a running session as working', () => {
    expect(statusMarker(session('working'), []).tone).toBe('working')
  })

  it('shows a session that stopped and has not moved since as done', () => {
    expect(statusMarker(session('idle', 5_000), []).tone).toBe('done')
  })

  it('does not call a running or waiting session done, even with a stale stoppedAt', () => {
    expect(statusMarker(session('working', 5_000), []).tone).toBe('working')
    expect(statusMarker(session('waiting', 5_000), []).tone).toBe('waiting')
  })

  it('shows a plain idle session as idle', () => {
    expect(statusMarker(session('idle'), []).tone).toBe('idle')
  })

  it('gives every state its own glyph and a Hungarian tooltip', () => {
    const markers = [
      statusMarker(session('waiting'), []),
      statusMarker(session('waiting'), [{ released: true }]),
      statusMarker(session('working'), []),
      statusMarker(session('idle', 1), []),
      statusMarker(session('idle'), []),
    ]
    // Színvak felhasználónak is meg kell különböztetnie: a jel alakja is más, nem csak a színe.
    expect(new Set(markers.map((m) => m.glyph)).size).toBe(markers.length)
    for (const marker of markers) expect(marker.title.trim()).not.toBe('')
  })
})

describe('hasRemoteControl', () => {
  it('is true for a non-empty bridge session id', () => {
    expect(hasRemoteControl({ bridgeSessionId: 'session_01Uj' })).toBe(true)
  })

  it('is false for a missing, null or blank bridge session id', () => {
    for (const bridgeSessionId of [undefined, null, '', '   ']) {
      expect(hasRemoteControl({ bridgeSessionId })).toBe(false)
    }
  })

  it('is false for a non-string at runtime — the daemon message can be anything', () => {
    expect(hasRemoteControl({ bridgeSessionId: 42 })).toBe(false)
  })
})
