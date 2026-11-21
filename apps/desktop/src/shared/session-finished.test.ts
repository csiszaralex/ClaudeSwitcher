import type { SessionStatus } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
import type { LinkedSession } from './prompt-links.js'
import { acknowledgeFinish, clearFinish, finishState, hasFinished, seenFinishesReply, waitsOn, type SeenFinish } from './session-finished.js'

// Invented sessions and pipes in the measured shapes (design doc "Cross-session messages").
const SESSION_ID = '6f1c2a3e-0000-4000-8000-000000000011'
const PIPE = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
const OTHER_PIPE = String.raw`\\.\pipe\LOCAL\cc-msg-f9e8d7c6b5a4938271605f4e3d2c1b0a`
const finished = (stoppedAt: number) => ({ sessionId: SESSION_ID, status: 'idle' as const, stoppedAt, messagingSocketPath: PIPE })

/** A session that works for the senders with these pipes. */
const recipient = (sessionId: string, name: string, status: SessionStatus, ...pipes: string[]): LinkedSession => ({
  sessionId,
  name,
  status,
  activity: { promptedBy: pipes.map((pipe) => ({ pipe, name: 'Orchestrator' })) },
})

describe('hasFinished', () => {
  it('is true for an idle session with a stoppedAt', () => {
    expect(hasFinished({ sessionId: SESSION_ID, status: 'idle', stoppedAt: 5_000 }, [])).toBe(true)
  })

  it('is false without a stoppedAt', () => {
    expect(hasFinished({ sessionId: SESSION_ID, status: 'idle' }, [])).toBe(false)
    expect(hasFinished({ sessionId: SESSION_ID, status: 'idle', stoppedAt: undefined }, [])).toBe(false)
  })

  it('is false for a session that runs or waits again, even with a stale stoppedAt', () => {
    expect(hasFinished({ sessionId: SESSION_ID, status: 'working', stoppedAt: 5_000 }, [])).toBe(false)
    expect(hasFinished({ sessionId: SESSION_ID, status: 'waiting', stoppedAt: 5_000 }, [])).toBe(false)
  })

  it('is false while a session it prompted still works, and true again once that one is idle', () => {
    expect(hasFinished(finished(5_000), [recipient('r1', 'Worker', 'working', PIPE)])).toBe(false)
    expect(hasFinished(finished(5_000), [recipient('r1', 'Worker', 'waiting', PIPE)])).toBe(false)
    expect(hasFinished(finished(5_000), [recipient('r1', 'Worker', 'idle', PIPE)])).toBe(true)
  })
})

describe('waitsOn', () => {
  it('names one recipient that works on the message', () => {
    expect(waitsOn(finished(5_000), [recipient('r1', 'Worker', 'working', PIPE)]).map((s) => s.name)).toEqual(['Worker'])
  })

  it('names several recipients by name, and only the ones that work or wait', () => {
    const sessions = [
      recipient('r3', 'CRM master', 'waiting', PIPE),
      recipient('r1', 'BohemApp', 'working', PIPE),
      recipient('r2', 'Idle one', 'idle', PIPE),
      recipient('r4', 'Someone else', 'working', OTHER_PIPE),
    ]
    expect(waitsOn(finished(5_000), sessions).map((s) => s.name)).toEqual(['BohemApp', 'CRM master'])
  })

  it('waits on none that is gone from the list', () => {
    // A recipient that is not live has no row: the sender's transcript cannot tell, only the list.
    expect(waitsOn(finished(5_000), [])).toEqual([])
    expect(hasFinished(finished(5_000), [])).toBe(true)
  })

  it('waits on nothing while the session works again, for example on the reply', () => {
    const sessions = [recipient('r1', 'Worker', 'working', PIPE)]
    expect(waitsOn({ ...finished(5_000), status: 'working' }, sessions)).toEqual([])
    expect(waitsOn({ sessionId: SESSION_ID, status: 'working', messagingSocketPath: PIPE }, sessions)).toEqual([])
  })

  it('waits on nothing without a pipe, and never on itself', () => {
    const sessions = [recipient('r1', 'Worker', 'working', PIPE)]
    expect(waitsOn({ ...finished(5_000), messagingSocketPath: undefined }, sessions)).toEqual([])
    expect(waitsOn({ ...finished(5_000), messagingSocketPath: '' }, [recipient('r1', 'Worker', 'working', '')])).toEqual([])
    expect(waitsOn(finished(5_000), [{ ...recipient(SESSION_ID, 'Self', 'working', PIPE) }])).toEqual([])
  })

  it('lets two senders wait on the same recipient', () => {
    const shared = recipient('r1', 'Worker', 'working', PIPE, OTHER_PIPE)
    const other = { sessionId: 'other', status: 'idle' as const, stoppedAt: 7_000, messagingSocketPath: OTHER_PIPE }
    expect(waitsOn(finished(5_000), [shared]).map((s) => s.sessionId)).toEqual(['r1'])
    expect(waitsOn(other, [shared]).map((s) => s.sessionId)).toEqual(['r1'])
  })

  it('settles a mesh where two sessions name each other, without a loop', () => {
    // Each names the other as its sender. A session that waits is idle, so neither counts for the
    // other: both are finished. With one of them working, only the other waits, on it.
    const a = { sessionId: 'a', name: 'A', status: 'idle' as const, stoppedAt: 1_000, messagingSocketPath: PIPE, activity: { promptedBy: [{ pipe: OTHER_PIPE }] } }
    const b = { sessionId: 'b', name: 'B', status: 'idle' as const, stoppedAt: 2_000, messagingSocketPath: OTHER_PIPE, activity: { promptedBy: [{ pipe: PIPE }] } }
    expect(hasFinished(a, [a, b])).toBe(true)
    expect(hasFinished(b, [a, b])).toBe(true)
    const bWorking = { ...b, status: 'working' as const }
    expect(waitsOn(a, [a, bWorking]).map((s) => s.sessionId)).toEqual(['b'])
    expect(waitsOn(bWorking, [a, bWorking])).toEqual([])
  })
})

describe('acknowledgeFinish', () => {
  it('records the stoppedAt the user has seen', () => {
    const seen = new Map<string, SeenFinish>()
    acknowledgeFinish(seen, finished(5_000), [])
    expect(seen.get(SESSION_ID)).toEqual({ stoppedAt: 5_000, cleared: false })
  })

  it('keeps a cleared finish cleared when the same finish is seen again', () => {
    const seen = new Map<string, SeenFinish>()
    clearFinish(seen, finished(5_000), [])
    acknowledgeFinish(seen, finished(5_000), [])
    expect(finishState(finished(5_000), seen, [])).toBe('none')
  })

  it('records nothing for a session without a stoppedAt', () => {
    const seen = new Map<string, SeenFinish>()
    acknowledgeFinish(seen, { sessionId: SESSION_ID, status: 'idle' }, [])
    expect(seen.size).toBe(0)
  })

  it('records nothing while the session waits on a session it prompted', () => {
    const seen = new Map<string, SeenFinish>()
    acknowledgeFinish(seen, finished(5_000), [recipient('r1', 'Worker', 'working', PIPE)])
    expect(seen.size).toBe(0)
  })
})

describe('finishState', () => {
  it('is unseen for a finish nobody has acknowledged', () => {
    expect(finishState(finished(5_000), new Map(), [])).toBe('unseen')
  })

  it('is seen once that stoppedAt is acknowledged', () => {
    const seen = new Map<string, SeenFinish>()
    acknowledgeFinish(seen, finished(5_000), [])
    expect(finishState(finished(5_000), seen, [])).toBe('seen')
  })

  it('is unseen again for a new stoppedAt after a seen one', () => {
    const seen = new Map<string, SeenFinish>()
    acknowledgeFinish(seen, finished(5_000), [])
    expect(finishState(finished(9_000), seen, [])).toBe('unseen')
  })

  it('is none for a session that has not finished, seen or not', () => {
    const seen = new Map([[SESSION_ID, { stoppedAt: 5_000, cleared: false }]])
    expect(finishState({ sessionId: SESSION_ID, status: 'idle' }, seen, [])).toBe('none')
    expect(finishState({ ...finished(5_000), status: 'working' }, seen, [])).toBe('none')
  })

  it('is none while the session waits, and unseen with the same stoppedAt once the last recipient is idle', () => {
    const working = recipient('r1', 'Worker', 'working', PIPE)
    expect(finishState(finished(5_000), new Map(), [working])).toBe('none')
    expect(finishState(finished(5_000), new Map(), [{ ...working, status: 'idle' }])).toBe('unseen')
  })
})

describe('clearFinish', () => {
  it('clears an unseen finish: it counts as seen and shows no ✓', () => {
    const seen = new Map<string, SeenFinish>()
    expect(clearFinish(seen, finished(5_000), [])).toBe(true)
    expect(finishState(finished(5_000), seen, [])).toBe('none')
  })

  it('clears a seen finish', () => {
    const seen = new Map<string, SeenFinish>()
    acknowledgeFinish(seen, finished(5_000), [])
    expect(clearFinish(seen, finished(5_000), [])).toBe(true)
    expect(finishState(finished(5_000), seen, [])).toBe('none')
  })

  it('shows the next finish again: a new stoppedAt is unseen', () => {
    const seen = new Map<string, SeenFinish>()
    clearFinish(seen, finished(5_000), [])
    expect(finishState(finished(9_000), seen, [])).toBe('unseen')
  })

  it('keeps the finish cleared while a subagent hides its stoppedAt, and after it comes back', () => {
    const seen = new Map<string, SeenFinish>()
    clearFinish(seen, finished(5_000), [])
    expect(finishState({ sessionId: SESSION_ID, status: 'idle' }, seen, [])).toBe('none')
    expect(finishState(finished(5_000), seen, [])).toBe('none')
  })

  it('does nothing on a session that works again: the key arrived after a new turn began', () => {
    const seen = new Map<string, SeenFinish>()
    expect(clearFinish(seen, { ...finished(5_000), status: 'working' }, [])).toBe(false)
    expect(clearFinish(seen, { sessionId: SESSION_ID, status: 'idle' }, [])).toBe(false)
    expect(seen.size).toBe(0)
  })

  it('does nothing on a session that waits on a session it prompted', () => {
    const seen = new Map<string, SeenFinish>()
    expect(clearFinish(seen, finished(5_000), [recipient('r1', 'Worker', 'working', PIPE)])).toBe(false)
    expect(seen.size).toBe(0)
  })

  it('is idempotent: a second press changes nothing', () => {
    const seen = new Map<string, SeenFinish>()
    expect(clearFinish(seen, finished(5_000), [])).toBe(true)
    expect(clearFinish(seen, finished(5_000), [])).toBe(false)
    expect(seenFinishesReply(seen)).toEqual([[SESSION_ID, 5_000, true]])
  })
})

describe('seenFinishesReply', () => {
  it('gives each finish as a [sessionId, stoppedAt, cleared] triple', () => {
    const seen = new Map<string, SeenFinish>([
      [SESSION_ID, { stoppedAt: 5_000, cleared: false }],
      ['6f1c2a3e-0000-4000-8000-000000000012', { stoppedAt: 7_000, cleared: true }],
    ])
    expect(seenFinishesReply(seen)).toEqual([
      [SESSION_ID, 5_000, false],
      ['6f1c2a3e-0000-4000-8000-000000000012', 7_000, true],
    ])
  })
})
