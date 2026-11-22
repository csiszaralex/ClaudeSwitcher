import { describe, expect, it } from 'vitest'
import { ALLOW_DECISION, autoAcceptTakes, type AutoAcceptRequest } from './auto-accept.js'

/** A readable, held command request with an invented command: the one the mode takes. */
const COMMAND: AutoAcceptRequest = { kind: 'tool', readable: true, released: false, toolInput: { command: 'pnpm test' } }

describe('autoAcceptTakes', () => {
  it('takes a readable, held command and a file write', () => {
    expect(autoAcceptTakes(COMMAND)).toBe(true)
    expect(autoAcceptTakes({ ...COMMAND, kind: 'edit', toolInput: { file_path: 'p:\proj\alpha\a.txt', content: 'x' } })).toBe(true)
  })

  it('never takes a question', () => {
    expect(autoAcceptTakes({ ...COMMAND, kind: 'question' })).toBe(false)
  })

  it('never takes a plan', () => {
    expect(autoAcceptTakes({ ...COMMAND, kind: 'plan' })).toBe(false)
  })

  it('never takes an unreadable request', () => {
    expect(autoAcceptTakes({ ...COMMAND, readable: false })).toBe(false)
  })

  it('never takes a request the app has released', () => {
    expect(autoAcceptTakes({ ...COMMAND, released: true })).toBe(false)
  })

  it('never takes a command that turns off the sandbox', () => {
    expect(autoAcceptTakes({ ...COMMAND, toolInput: { command: 'pnpm test', dangerouslyDisableSandbox: true } })).toBe(false)
    // Only an explicit `true` turns it off (`sandboxDisabled`).
    expect(autoAcceptTakes({ ...COMMAND, toolInput: { command: 'pnpm test', dangerouslyDisableSandbox: false } })).toBe(true)
  })
})

describe('ALLOW_DECISION', () => {
  it('is the plain allow, never a rule or the session edits', () => {
    expect(ALLOW_DECISION).toEqual({ type: 'allow' })
  })
})
