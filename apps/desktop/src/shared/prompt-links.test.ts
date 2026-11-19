import { describe, expect, it } from 'vitest'
import { promptersOf, recipientsOf, type LinkedSession } from './prompt-links.js'

// Invented sessions and pipes in the measured shapes (design doc "Cross-session messages").
const PIPE_A = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
const PIPE_B = String.raw`\\.\pipe\LOCAL\cc-msg-f9e8d7c6b5a4938271605f4e3d2c1b0a`
const PIPE_GONE = String.raw`\\.\pipe\LOCAL\cc-msg-00112233445566778899aabbccddeeff`

const orchestrator: LinkedSession = { sessionId: 'o', name: 'Orchestrator', status: 'idle', messagingSocketPath: PIPE_A }
const reviewer: LinkedSession = { sessionId: 'r', name: 'Reviewer', status: 'working', messagingSocketPath: PIPE_B }
const worker = (status: LinkedSession['status'], ...senders: { pipe: string; name?: string }[]): LinkedSession => ({
  sessionId: 'w',
  name: 'Worker',
  status,
  activity: { promptedBy: senders },
})

describe('recipientsOf', () => {
  it('finds the live sessions that work for the pipe, by name', () => {
    const second = { ...worker('waiting', { pipe: PIPE_A }), sessionId: 'w2', name: 'Another worker' }
    expect(recipientsOf(orchestrator, [orchestrator, worker('working', { pipe: PIPE_A }), second]).map((s) => s.name)).toEqual([
      'Another worker',
      'Worker',
    ])
  })

  it('leaves out an idle recipient and one that works for another pipe', () => {
    expect(recipientsOf(orchestrator, [worker('idle', { pipe: PIPE_A })])).toEqual([])
    expect(recipientsOf(orchestrator, [worker('working', { pipe: PIPE_B })])).toEqual([])
  })
})

describe('promptersOf', () => {
  it('names the sender by its live row name', () => {
    expect(promptersOf(worker('working', { pipe: PIPE_A, name: 'name in the message' }), [orchestrator])).toEqual(['Orchestrator'])
  })

  it('falls back to the name the message gave for a sender that is not live, and skips one without a name', () => {
    expect(promptersOf(worker('working', { pipe: PIPE_GONE, name: 'Old orchestrator' }, { pipe: PIPE_GONE }), [])).toEqual([
      'Old orchestrator',
    ])
    expect(promptersOf(worker('working', { pipe: PIPE_GONE }), [])).toEqual([])
  })

  it('names two senders once each, in a stable order', () => {
    const sessions = [reviewer, orchestrator]
    expect(promptersOf(worker('waiting', { pipe: PIPE_B }, { pipe: PIPE_A }, { pipe: PIPE_B }), sessions)).toEqual([
      'Orchestrator',
      'Reviewer',
    ])
  })

  it('names nobody while the session is idle', () => {
    expect(promptersOf(worker('idle', { pipe: PIPE_A }), [orchestrator])).toEqual([])
  })
})
