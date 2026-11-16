import { describe, expect, it } from 'vitest'
import { capitalized, requestFacts, requestSource, sessionHost } from './request-source.js'

describe('requestSource', () => {
  it('labels the VS Code extension and does not emphasise it', () => {
    expect(requestSource('claude-vscode')).toMatchObject({ label: 'VS Code', standsOut: false })
  })

  it('labels an interactive terminal session and does not emphasise it', () => {
    expect(requestSource('cli')).toMatchObject({ label: 'CLI', standsOut: false })
  })

  it('labels a headless claude -p run and emphasises it', () => {
    expect(requestSource('sdk-cli')).toMatchObject({ label: 'claude -p', standsOut: true })
  })

  it('shows a value without a measured meaning raw and emphasises it', () => {
    expect(requestSource('sdk-future')).toMatchObject({ label: 'sdk-future', standsOut: true })
  })

  it('marks a session without a registry record as unknown and emphasises it', () => {
    expect(requestSource(undefined)).toMatchObject({ label: 'ismeretlen', standsOut: true })
  })

  it('explains the label in terms of the session, so it reads right without a request too', () => {
    expect(requestSource('claude-vscode').title).toBe('Ebből a környezetből indított session.')
    expect(requestSource('sdk-cli').title).toBe('Nem interaktívan indított session.')
    expect(requestSource(undefined).title).toBe('A session forrása ismeretlen: nincs a nyilvántartásban, vagy nem írja, honnan indult.')
  })

  it('does not treat a prototype key as a known label', () => {
    expect(requestSource('constructor').label).toBe('constructor')
  })
})

describe('sessionHost', () => {
  it('keeps the VS Code wording for an extension session', () => {
    expect(sessionHost('claude-vscode')).toEqual({ inside: 'a VSCode-ban', to: 'a VSCode-ba' })
  })

  it('names the terminal for an interactive terminal session and a claude -p run', () => {
    for (const entrypoint of ['cli', 'sdk-cli']) {
      expect(sessionHost(entrypoint)).toEqual({ inside: 'a terminálban', to: 'a terminálhoz' })
    }
  })

  it('names the session itself when the source is unknown or has no measured meaning', () => {
    for (const entrypoint of [undefined, 'sdk-future', '', 'Claude-VSCode', 'CLI', 'constructor']) {
      expect(sessionHost(entrypoint)).toEqual({ inside: 'a sessionben', to: 'a sessionhöz' })
    }
  })

  it('is the host the source carries, so the panel and the notices agree', () => {
    for (const entrypoint of ['claude-vscode', 'cli', 'sdk-cli', 'sdk-future', undefined]) {
      expect(requestSource(entrypoint).host).toEqual(sessionHost(entrypoint))
    }
  })
})

describe('capitalized', () => {
  it('starts a sentence with the phrase, accented letters included', () => {
    expect(capitalized('a terminálban')).toBe('A terminálban')
    expect(capitalized('új')).toBe('Új')
    expect(capitalized('')).toBe('')
  })
})

describe('requestFacts', () => {
  it('shows the folder alone for the default mode', () => {
    expect(requestFacts({ cwd: 'p:\proj\alpha', permissionMode: 'default' })).toBe('p:\proj\alpha')
  })

  it('adds a non-default mode raw', () => {
    expect(requestFacts({ cwd: 'p:\proj\alpha', permissionMode: 'acceptEdits' })).toBe('p:\proj\alpha · mód: acceptEdits')
  })

  it('omits a missing mode and an empty folder', () => {
    expect(requestFacts({ cwd: 'p:\proj\alpha' })).toBe('p:\proj\alpha')
    expect(requestFacts({ cwd: '', permissionMode: 'plan' })).toBe('mód: plan')
    expect(requestFacts({ cwd: '' })).toBeUndefined()
  })
})
