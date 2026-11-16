import { describe, expect, it } from 'vitest'
import type { SessionStatus as Status } from '@claudeswitcher/core'
import { PERMISSION_RELEASE_AFTER_MS } from '@claudeswitcher/core/browser'
import { hasRemoteControl, releasedMessage, statusMarker } from './session-marker.js'

const session = (status: Status, stoppedAt?: number): { status: Status; stoppedAt?: number | undefined } => ({
  status,
  stoppedAt,
})

describe('statusMarker', () => {
  it('shows a held decision as waiting for a reply', () => {
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'tool' as const }]).tone).toBe('waiting')
  })

  it('shows a Notification wait (no held decision) as waiting too', () => {
    expect(statusMarker(session('waiting'), []).tone).toBe('waiting')
  })

  it('shows a released decision differently: only VS Code or the phone can answer it now', () => {
    expect(statusMarker(session('waiting'), [{ released: true, kind: 'tool' as const }]).tone).toBe('released')
  })

  it('prefers a still-held decision over a released one of the same session', () => {
    // While there is a request the app can decide, that is the more important sign.
    expect(statusMarker(session('waiting'), [{ released: true, kind: 'tool' as const }, { released: false, kind: 'tool' as const }]).tone).toBe('waiting')
  })

  it('shows a held question or plan in the choice tone, a held command or edit in the yes/no tone', () => {
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'question' }]).tone).toBe('choice')
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'plan' }]).tone).toBe('choice')
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'tool' }]).tone).toBe('waiting')
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'edit' }]).tone).toBe('waiting')
  })

  it('shows a row with one choice request among yes/no ones in the choice tone', () => {
    const decisions = [
      { released: false, kind: 'tool' as const },
      { released: false, kind: 'question' as const },
    ]
    expect(statusMarker(session('waiting'), decisions).tone).toBe('choice')
  })

  it('ignores a released choice request: the held yes/no one decides the tone', () => {
    const decisions = [
      { released: true, kind: 'plan' as const },
      { released: false, kind: 'edit' as const },
    ]
    expect(statusMarker(session('waiting'), decisions).tone).toBe('waiting')
    expect(statusMarker(session('waiting'), [{ released: true, kind: 'plan' as const }]).tone).toBe('released')
  })

  it('gives the choice dot its own Hungarian tooltip', () => {
    const choice = statusMarker(session('waiting'), [{ released: false, kind: 'question' }])
    const yesNo = statusMarker(session('waiting'), [{ released: false, kind: 'tool' }])
    expect(choice.title.trim()).not.toBe('')
    expect(choice.title).not.toBe(yesNo.title)
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
      statusMarker(session('waiting'), [{ released: true, kind: 'tool' as const }]),
      statusMarker(session('working'), []),
      statusMarker(session('idle', 1), []),
      statusMarker(session('idle'), []),
    ]
    // A color-blind user must tell them apart too: the glyph's shape differs, not just its color.
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

  it('is false for a non-string at runtime: the daemon message can be anything', () => {
    expect(hasRemoteControl({ bridgeSessionId: 42 })).toBe(false)
  })
})

describe('releasedMessage', () => {
  it('names only VS Code without Remote Control', () => {
    const text = releasedMessage(false)
    expect(text).toContain('VSCode')
    expect(text).not.toContain('telefon')
  })

  it('names VS Code and the phone with Remote Control', () => {
    expect(releasedMessage(true)).toContain('VSCode-ban vagy a telefonon')
  })

  it('has no dash inside the sentence', () => {
    for (const remote of [false, true]) expect(releasedMessage(remote)).not.toMatch(/[–—]/)
  })
})

describe('statusMarker released tooltip', () => {
  const released = [{ released: true, kind: 'tool' as const }]

  it('mentions the phone only for a session with Remote Control', () => {
    const plain = statusMarker({ status: 'waiting' }, released)
    const remote = statusMarker({ status: 'waiting', bridgeSessionId: 'session_01Uj' }, released)
    expect(plain.title).not.toContain('telefon')
    expect(plain.title).toContain('VSCode')
    expect(remote.title).toContain('telefonon')
  })

  it('keeps the release time in the tooltip', () => {
    expect(statusMarker({ status: 'waiting' }, released).title).toContain(`${String(PERMISSION_RELEASE_AFTER_MS / 1000)} mp`)
  })
})
