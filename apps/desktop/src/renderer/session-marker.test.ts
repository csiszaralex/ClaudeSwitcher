import { describe, expect, it } from 'vitest'
import type { SessionStatus as Status } from '@claudeswitcher/core'
import { PERMISSION_RELEASE_AFTER_MS, UNREADABLE_REQUEST } from '@claudeswitcher/core/browser'
import { sessionHost } from '../shared/request-source.js'
import { hasRemoteControl, outsideAppMessage, releasedMessage, statusMarker, unreadableMessage } from './session-marker.js'

const SESSION_ID = '6f1c2a3e-0000-4000-8000-000000000031'
const session = (status: Status, stoppedAt?: number): { sessionId: string; status: Status; stoppedAt?: number | undefined } => ({
  sessionId: SESSION_ID,
  status,
  stoppedAt,
})
/** Nothing seen, unless a test says otherwise. */
const NONE_SEEN = new Map<string, number>()

describe('statusMarker', () => {
  it('shows a held decision as waiting for a reply', () => {
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'tool' as const }], NONE_SEEN).tone).toBe('waiting')
  })

  it('shows a Notification wait (no held decision) as waiting too', () => {
    expect(statusMarker(session('waiting'), [], NONE_SEEN).tone).toBe('waiting')
  })

  it('shows a released decision differently: only VS Code or the phone can answer it now', () => {
    expect(statusMarker(session('waiting'), [{ released: true, kind: 'tool' as const }], NONE_SEEN).tone).toBe('released')
  })

  it('prefers a still-held decision over a released one of the same session', () => {
    // While there is a request the app can decide, that is the more important sign.
    expect(statusMarker(session('waiting'), [{ released: true, kind: 'tool' as const }, { released: false, kind: 'tool' as const }], NONE_SEEN).tone).toBe('waiting')
  })

  it('shows a held question or plan in the choice tone, a held command or edit in the yes/no tone', () => {
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'question' }], NONE_SEEN).tone).toBe('choice')
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'plan' }], NONE_SEEN).tone).toBe('choice')
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'tool' }], NONE_SEEN).tone).toBe('waiting')
    expect(statusMarker(session('waiting'), [{ released: false, kind: 'edit' }], NONE_SEEN).tone).toBe('waiting')
  })

  it('shows a row with one choice request among yes/no ones in the choice tone', () => {
    const decisions = [
      { released: false, kind: 'tool' as const },
      { released: false, kind: 'question' as const },
    ]
    expect(statusMarker(session('waiting'), decisions, NONE_SEEN).tone).toBe('choice')
  })

  it('ignores a released choice request: the held yes/no one decides the tone', () => {
    const decisions = [
      { released: true, kind: 'plan' as const },
      { released: false, kind: 'edit' as const },
    ]
    expect(statusMarker(session('waiting'), decisions, NONE_SEEN).tone).toBe('waiting')
    expect(statusMarker(session('waiting'), [{ released: true, kind: 'plan' as const }], NONE_SEEN).tone).toBe('released')
  })

  it('gives the choice dot its own Hungarian tooltip', () => {
    const choice = statusMarker(session('waiting'), [{ released: false, kind: 'question' }], NONE_SEEN)
    const yesNo = statusMarker(session('waiting'), [{ released: false, kind: 'tool' }], NONE_SEEN)
    expect(choice.title.trim()).not.toBe('')
    expect(choice.title).not.toBe(yesNo.title)
  })

  it('shows a running session as working', () => {
    expect(statusMarker(session('working'), [], NONE_SEEN).tone).toBe('working')
  })

  it('shows a session that stopped and has not moved since as done: a green ✓ while unseen', () => {
    const marker = statusMarker(session('idle', 5_000), [], NONE_SEEN)
    expect(marker.tone).toBe('done')
    expect(marker.glyph).toBe('✓')
    expect(marker.title).toBe('Épp végzett')
  })

  it('shows a seen finish as a blue ✓ with its own tooltip', () => {
    const marker = statusMarker(session('idle', 5_000), [], new Map([[SESSION_ID, 5_000]]))
    expect(marker.tone).toBe('seen')
    expect(marker.glyph).toBe('✓')
    expect(marker.title).toBe('Végzett, már megnyitottad')
  })

  it('shows a new stoppedAt after a seen one as green again', () => {
    expect(statusMarker(session('idle', 9_000), [], new Map([[SESSION_ID, 5_000]])).tone).toBe('done')
  })

  it('ignores the seen finish of another session', () => {
    expect(statusMarker(session('idle', 5_000), [], new Map([['6f1c2a3e-0000-4000-8000-000000000032', 5_000]])).tone).toBe('done')
  })

  it('does not call a running or waiting session done, even with a stale stoppedAt', () => {
    expect(statusMarker(session('working', 5_000), [], NONE_SEEN).tone).toBe('working')
    expect(statusMarker(session('waiting', 5_000), [], NONE_SEEN).tone).toBe('waiting')
  })

  it('shows a plain idle session as idle', () => {
    expect(statusMarker(session('idle'), [], NONE_SEEN).tone).toBe('idle')
  })

  it('gives every state its own glyph and a Hungarian tooltip', () => {
    const markers = [
      statusMarker(session('waiting'), [], NONE_SEEN),
      statusMarker(session('waiting'), [{ released: true, kind: 'tool' as const }], NONE_SEEN),
      statusMarker(session('working'), [], NONE_SEEN),
      statusMarker(session('idle', 1), [], NONE_SEEN),
      statusMarker(session('idle'), [], NONE_SEEN),
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

/** One `entrypoint` of each host: the extension, the two terminal sources, and unknown ones. */
const ENTRYPOINTS = ['claude-vscode', 'cli', 'sdk-cli', 'sdk-future', undefined] as const

describe('releasedMessage', () => {
  it("names the session's own host, and the phone only with Remote Control", () => {
    expect(releasedMessage(false, sessionHost('claude-vscode'))).toBe('A VS Code-ban még dönthetsz.')
    expect(releasedMessage(true, sessionHost('claude-vscode'))).toBe('A VS Code-ban vagy a telefonon még dönthetsz.')
    expect(releasedMessage(false, sessionHost('cli'))).toBe('A terminálban még dönthetsz.')
    expect(releasedMessage(true, sessionHost('sdk-cli'))).toBe('A terminálban vagy a telefonon még dönthetsz.')
    expect(releasedMessage(false, sessionHost(undefined))).toBe('A sessionben még dönthetsz.')
    expect(releasedMessage(true, sessionHost('sdk-future'))).toBe('A sessionben vagy a telefonon még dönthetsz.')
  })

  it('has no dash inside the sentence', () => {
    for (const entrypoint of ENTRYPOINTS) {
      for (const remote of [false, true]) expect(releasedMessage(remote, sessionHost(entrypoint))).not.toMatch(/[–—]/)
    }
  })
})

describe('outsideAppMessage', () => {
  it("names the session's own host at the start of the sentence", () => {
    const reason = 'Az appból ezt nem lehet eldönteni (az app újraindult, vagy a kérés nem hozzá érkezett).'
    expect(outsideAppMessage(sessionHost('claude-vscode'))).toBe(`A VS Code-ban vár jóváhagyásra. ${reason}`)
    expect(outsideAppMessage(sessionHost('cli'))).toBe(`A terminálban vár jóváhagyásra. ${reason}`)
    expect(outsideAppMessage(sessionHost('sdk-cli'))).toBe(`A terminálban vár jóváhagyásra. ${reason}`)
    expect(outsideAppMessage(sessionHost(undefined))).toBe(`A sessionben vár jóváhagyásra. ${reason}`)
  })

  it('has no dash inside a sentence', () => {
    for (const entrypoint of ENTRYPOINTS) expect(outsideAppMessage(sessionHost(entrypoint))).not.toMatch(/[–—]/)
  })
})

describe('unreadableMessage', () => {
  it("follows the core's text with the way out at the session's own host, named once", () => {
    const at = (entrypoint: string | undefined): string => unreadableMessage(sessionHost(entrypoint))
    expect(at('claude-vscode')).toBe(`${UNREADABLE_REQUEST} Tilthatod, vagy dönts a VS Code-ban.`)
    expect(at('cli')).toBe(`${UNREADABLE_REQUEST} Tilthatod, vagy dönts a terminálban.`)
    expect(at('sdk-cli')).toBe(`${UNREADABLE_REQUEST} Tilthatod, vagy dönts a terminálban.`)
    expect(at(undefined)).toBe(`${UNREADABLE_REQUEST} Tilthatod, vagy dönts a sessionben.`)
    expect(at('sdk-future')).toBe(`${UNREADABLE_REQUEST} Tilthatod, vagy dönts a sessionben.`)
    expect(at('cli')).not.toContain('VS Code')
  })

  it('has no dash inside a sentence', () => {
    for (const entrypoint of ENTRYPOINTS) expect(unreadableMessage(sessionHost(entrypoint))).not.toMatch(/[–—]/)
  })
})

describe('statusMarker released tooltip', () => {
  const released = [{ released: true, kind: 'tool' as const }]

  it('mentions the phone only for a session with Remote Control', () => {
    const plain = statusMarker({ sessionId: SESSION_ID, status: 'waiting' }, released, NONE_SEEN)
    const remote = statusMarker({ sessionId: SESSION_ID, status: 'waiting', bridgeSessionId: 'session_01Uj' }, released, NONE_SEEN)
    expect(plain.title).not.toContain('telefon')
    expect(remote.title).toContain('telefonon')
  })

  it("names the session's own host, from its entrypoint", () => {
    const at = (entrypoint: string | undefined): string =>
      statusMarker({ sessionId: SESSION_ID, status: 'waiting', entrypoint }, released, NONE_SEEN).title
    expect(at('claude-vscode')).toContain('A VS Code-ban még dönthetsz.')
    expect(at('cli')).toContain('A terminálban még dönthetsz.')
    expect(at(undefined)).toContain('A sessionben még dönthetsz.')
  })

  it('keeps the release time in the tooltip', () => {
    expect(statusMarker({ sessionId: SESSION_ID, status: 'waiting' }, released, NONE_SEEN).title).toContain(`${String(PERMISSION_RELEASE_AFTER_MS / 1000)} mp`)
  })
})
