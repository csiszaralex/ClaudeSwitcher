import { describe, expect, it } from 'vitest'
import { requestFacts, requestSource } from './request-source.js'

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

  it('does not treat a prototype key as a known label', () => {
    expect(requestSource('constructor').label).toBe('constructor')
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
