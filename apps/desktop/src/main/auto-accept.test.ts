import { hookPath, type UserDecision } from '@claudeswitcher/core'
import { fakeProbe, hookPayload, tempDir, writeSessionRecord } from '@claudeswitcher/core/testing'
import { startDaemon, type Daemon, type PendingDecisionView } from '@claudeswitcher/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_ACCEPT_GONE_AFTER_MS, createAutoAccept, type ModeDaemon, type ModeState } from './auto-accept.js'
import { createNotifier } from './notifier.js'
import { trayState } from './tray-state.js'

// Invented session ids in the registry's UUID shape.
const ALPHA = '6f1c2a3e-0000-4000-8000-0000000000a1'
const BETA = '6f1c2a3e-0000-4000-8000-0000000000a2'

type Request = ModeState['decisions'][number]

/** A held, readable command request of the session with an invented command. */
function command(id: string, sessionId: string, overrides: Partial<Request> = {}): Request {
  return { id, sessionId, toolName: 'Bash', kind: 'tool', readable: true, released: false, toolInput: { command: 'pnpm test' }, ...overrides }
}

/** A fake daemon: its state, and a `decide` that closes a held request as the broker does. */
function fakeDaemon(sessions: string[], decisions: Request[]): ModeDaemon & { decided: [string, UserDecision][] } {
  const state = { sessions: sessions.map((sessionId) => ({ sessionId })), decisions: [...decisions] }
  const decided: [string, UserDecision][] = []
  return {
    decided,
    state: () => ({ sessions: [...state.sessions], decisions: [...state.decisions] }),
    decide: (id, decision) => {
      const index = state.decisions.findIndex((request) => request.id === id)
      const request = state.decisions[index]
      if (request === undefined) return { ok: false, reason: 'closed' }
      if (request.released) return { ok: false, reason: 'released' }
      state.decisions.splice(index, 1)
      decided.push([id, decision])
      return { ok: true }
    },
  }
}

function setup() {
  const lines: string[] = []
  let changes = 0
  const mode = createAutoAccept({
    log: (line) => lines.push(line),
    onChange: () => {
      changes += 1
    },
  })
  return { mode, lines, changes: () => changes }
}

/** Asks the decider about a new request as the broker does, and tells it the outcome it gets. */
function arrive(mode: ReturnType<typeof setup>['mode'], request: Request): UserDecision | undefined {
  const view = request as unknown as PendingDecisionView
  const decision = mode.decider.decisionFor(view)
  if (decision !== undefined) mode.decider.decided(view, { ok: true })
  return decision
}

describe('createAutoAccept: switching on and off', () => {
  it('turns on for a listed session, allows its waiting request at once, and counts it', () => {
    const { mode, changes } = setup()
    const daemon = fakeDaemon([ALPHA], [command('r1', ALPHA), command('r2', BETA)])
    expect(mode.set(ALPHA, true, daemon)).toBe(true)
    expect(daemon.decided).toEqual([['r1', { type: 'allow' }]])
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 1 }])
    expect(changes()).toBe(1)
  })

  it('leaves the waiting requests it never takes: sandbox off, a question, a plan, unreadable, released', () => {
    const { mode } = setup()
    const waiting = [
      command('sandbox', ALPHA, { toolInput: { command: 'pnpm test', dangerouslyDisableSandbox: true } }),
      command('question', ALPHA, { kind: 'question' }),
      command('plan', ALPHA, { kind: 'plan' }),
      command('unreadable', ALPHA, { readable: false }),
      command('released', ALPHA, { released: true }),
    ]
    const daemon = fakeDaemon([ALPHA], waiting)
    mode.set(ALPHA, true, daemon)
    expect(daemon.decided).toEqual([])
    expect(daemon.state().decisions).toHaveLength(waiting.length)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
  })

  it('turns on for a session the daemon knows only by a pending request, but not for an unknown one', () => {
    const { mode } = setup()
    expect(mode.set(BETA, true, fakeDaemon([ALPHA], []))).toBe(false)
    expect(mode.entries()).toEqual([])
    expect(mode.set(BETA, true, fakeDaemon([ALPHA], [command('r1', BETA)]))).toBe(true)
    expect(mode.entries()).toEqual([{ sessionId: BETA, allowed: 1 }])
  })

  it('is idempotent both ways, and off forgets the count', () => {
    const { mode, changes } = setup()
    const daemon = fakeDaemon([ALPHA], [])
    expect(mode.set(ALPHA, true, daemon)).toBe(true)
    expect(mode.set(ALPHA, true, daemon)).toBe(false)
    arrive(mode, command('r1', ALPHA))
    expect(mode.set(ALPHA, false, daemon)).toBe(true)
    expect(mode.set(ALPHA, false, daemon)).toBe(false)
    expect(mode.entries()).toEqual([])
    expect(mode.set(ALPHA, true, daemon)).toBe(true)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
    expect(changes()).toBe(4)
  })
})

describe('createAutoAccept: the decider', () => {
  it('allows a new request of a session in the mode, with the plain allow, and counts and logs it', () => {
    const { mode, lines } = setup()
    mode.set(ALPHA, true, fakeDaemon([ALPHA], []))
    expect(arrive(mode, command('r1', ALPHA))).toEqual({ type: 'allow' })
    expect(arrive(mode, command('r2', ALPHA, { kind: 'edit', toolName: 'Write' }))).toEqual({ type: 'allow' })
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 2 }])
    expect(lines.at(-1)).toBe(`[claudeswitcher] auto-accept: allowed Write of session ${ALPHA} (2 since the last own prompt)`)
  })

  it('never logs the command', () => {
    const { mode, lines } = setup()
    mode.set(ALPHA, true, fakeDaemon([ALPHA], []))
    arrive(mode, command('r1', ALPHA, { toolInput: { command: 'echo invented-secret' } }))
    for (const line of lines) expect(line).not.toContain('invented-secret')
  })

  it('takes nothing of a session not in the mode', () => {
    const { mode } = setup()
    mode.set(ALPHA, true, fakeDaemon([ALPHA, BETA], []))
    expect(arrive(mode, command('r1', BETA))).toBeUndefined()
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
  })

  it('takes no released request and no command that turns off the sandbox', () => {
    const { mode } = setup()
    mode.set(ALPHA, true, fakeDaemon([ALPHA], []))
    expect(arrive(mode, command('r1', ALPHA, { released: true }))).toBeUndefined()
    expect(arrive(mode, command('r2', ALPHA, { toolInput: { command: 'ls', dangerouslyDisableSandbox: true } }))).toBeUndefined()
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
  })

  it('does not count a refused allow', () => {
    const { mode, changes } = setup()
    mode.set(ALPHA, true, fakeDaemon([ALPHA], []))
    const view = command('r1', ALPHA) as unknown as PendingDecisionView
    mode.decider.decided(view, { ok: false, reason: 'closed' })
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
    expect(changes()).toBe(1)
  })
})

describe('createAutoAccept: the count since the last own prompt', () => {
  /** The state with ALPHA listed and its last own prompt at `promptAt` (invented times). */
  const prompted = (promptAt: number | undefined): ModeState => ({
    sessions: [{ sessionId: ALPHA, activity: promptAt === undefined ? {} : { lastOwnPromptAt: promptAt } }],
    decisions: [],
  })
  /** A fake daemon whose ALPHA shows its last own prompt at `promptAt`. */
  const daemonAt = (promptAt: number | undefined): ModeDaemon => ({ state: () => prompted(promptAt), decide: () => ({ ok: true }) })

  it('starts again at 0 on a new own prompt, and pushes it', () => {
    const { mode, changes, lines } = setup()
    mode.set(ALPHA, true, daemonAt(1_000))
    arrive(mode, command('r1', ALPHA))
    arrive(mode, command('r2', ALPHA))
    const before = changes()
    expect(mode.observe(prompted(2_000), 5_000)).toBe(false)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
    expect(changes()).toBe(before + 1)
    expect(lines.at(-1)).toBe(`[claudeswitcher] auto-accept: a new own prompt of session ${ALPHA}; the count starts again`)
    // The same prompt again resets nothing; the count goes on from 0.
    arrive(mode, command('r3', ALPHA))
    mode.observe(prompted(2_000), 6_000)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 1 }])
  })

  it('keeps the count for the prompt it started at, an older one or none', () => {
    const { mode, changes } = setup()
    mode.set(ALPHA, true, daemonAt(1_000))
    arrive(mode, command('r1', ALPHA))
    const before = changes()
    mode.observe(prompted(1_000), 5_000)
    mode.observe(prompted(500), 6_000)
    mode.observe(prompted(undefined), 7_000)
    mode.observe({ sessions: [{ sessionId: ALPHA }], decisions: [] }, 8_000)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 1 }])
    expect(changes()).toBe(before)
  })

  it('resets on the first own prompt it sees when the session showed none at switch-on', () => {
    const { mode } = setup()
    mode.set(ALPHA, true, daemonAt(undefined))
    arrive(mode, command('r1', ALPHA))
    mode.observe(prompted(3_000), 5_000)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
  })

  it('pushes nothing for a new prompt while the count is 0, and a session not in the mode has none', () => {
    const { mode, changes } = setup()
    mode.set(ALPHA, true, daemonAt(1_000))
    const before = changes()
    mode.observe(prompted(2_000), 5_000)
    expect(changes()).toBe(before)
    // The new prompt is the count's start now: allowing after it, then seeing it again, keeps the count.
    arrive(mode, command('r1', ALPHA))
    mode.observe(prompted(2_000), 6_000)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 1 }])
    mode.set(ALPHA, false, daemonAt(2_000))
    mode.observe(prompted(9_000), 7_000)
    expect(mode.entries()).toEqual([])
  })
})

describe('createAutoAccept: a session that leaves the state', () => {
  it('drops it after AUTO_ACCEPT_GONE_AFTER_MS without a break, and not before', () => {
    const { mode, changes } = setup()
    mode.set(ALPHA, true, fakeDaemon([ALPHA], []))
    const without: ModeState = { sessions: [{ sessionId: BETA }], decisions: [] }
    expect(mode.observe(without, 0)).toBe(false)
    expect(mode.observe(without, AUTO_ACCEPT_GONE_AFTER_MS - 1)).toBe(false)
    expect(mode.entries()).toHaveLength(1)
    expect(mode.observe(without, AUTO_ACCEPT_GONE_AFTER_MS)).toBe(true)
    expect(mode.entries()).toEqual([])
    expect(changes()).toBe(2)
  })

  it('keeps a session that comes back, or that has a pending request, and restarts on an empty list', () => {
    const { mode } = setup()
    mode.set(ALPHA, true, fakeDaemon([ALPHA], []))
    const without: ModeState = { sessions: [{ sessionId: BETA }], decisions: [] }
    mode.observe(without, 0)
    mode.observe({ sessions: [{ sessionId: BETA }], decisions: [command('r1', ALPHA)] }, 1)
    expect(mode.observe(without, AUTO_ACCEPT_GONE_AFTER_MS)).toBe(false)
    mode.observe({ sessions: [], decisions: [] }, AUTO_ACCEPT_GONE_AFTER_MS + 1)
    expect(mode.observe(without, 2 * AUTO_ACCEPT_GONE_AFTER_MS)).toBe(false)
    expect(mode.entries()).toEqual([{ sessionId: ALPHA, allowed: 0 }])
  })
})

describe('createAutoAccept with the real daemon: an allowed request never notifies or colours the tray', () => {
  let running: Daemon | undefined
  afterEach(async () => {
    await running?.stop()
    running = undefined
  })

  /**
   * Posts a permission request of the fixture's session (`sid-100`) and returns the hook's answer:
   * its JSON, or `undefined` for the empty 200 of "no decision" (the release on the daemon's stop).
   */
  async function request(daemon: Daemon, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${String(daemon.port)}${hookPath('permission-request')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ ...body, session_id: 'sid-100' }),
    })
    const text = await res.text()
    return text === '' ? undefined : (JSON.parse(text) as unknown)
  }

  it('answers it before the state, the notifier or the tray can see it; a request it does not take notifies as before', async () => {
    const claudeDir = await tempDir('cs-auto-accept-')
    await writeSessionRecord(claudeDir)
    const { mode } = setup()
    running = await startDaemon({ claudeDir, probe: fakeProbe(), pollMs: 0, autoDecider: mode.decider })
    const daemon = running
    await daemon.refresh()
    expect(mode.set('sid-100', true, daemon)).toBe(true)

    const notifier = createNotifier()
    const tick = () => {
      const state = daemon.state()
      const notices = notifier.observe({
        state,
        settings: { notifyOnRequest: true, notifyOnFinish: true },
        overlayVisible: false,
        excluded: new Set(),
      })
      const tray = trayState({ ...state, acknowledged: new Map(), excluded: new Set(), now: Date.now() })
      return { notices, tray }
    }
    tick()

    expect(await request(daemon, hookPayload('permissionRequest_bash'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    const after = tick()
    expect(after.notices).toEqual([])
    expect(after.tray.wait).toBe('none')
    expect(after.tray.waitingCount).toBe(0)
    expect(mode.entries()).toEqual([{ sessionId: 'sid-100', allowed: 1 }])

    // A command without the sandbox is not taken: it is held, and notifies and colours as without the mode.
    const bash = hookPayload('permissionRequest_bash')
    const toolInput = { ...(bash['tool_input'] as Record<string, unknown>), dangerouslyDisableSandbox: true }
    const answer = request(daemon, { ...bash, tool_input: toolInput })
    await expect.poll(() => daemon.state().decisions.length).toBe(1)
    const held = tick()
    expect(held.notices.map((notice) => notice.kind)).toEqual(['request'])
    expect(held.tray.wait).toBe('yes-no')
    expect(mode.entries()).toEqual([{ sessionId: 'sid-100', allowed: 1 }])

    // The stop releases it with "no decision".
    await daemon.stop()
    running = undefined
    expect(await answer).toBeUndefined()
  })
})
