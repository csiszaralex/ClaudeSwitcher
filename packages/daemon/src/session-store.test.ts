import type { LiveSession, SessionActivity, SubagentView } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from './session-store.js'

function live(sessionId: string, over: Partial<LiveSession['record']> = {}): LiveSession {
  return {
    record: {
      pid: 1, sessionId, cwd: 'p:\\proj\\alpha', startedAt: 1,
      name: 'alpha-01', bridgeSessionId: 'session_01x', ...over,
    },
    window: { port: 1000, pid: 900, workspaceFolders: ['p:\\proj\\alpha'] },
  }
}

const noActivity = new Map<string, SessionActivity>()

describe('SessionStore', () => {
  it('projects a snapshot into views', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    const [view] = store.views()
    expect(view!.sessionId).toBe('s1')
    expect(view!.name).toBe('alpha-01')
    expect(view!.pid).toBe(1)
    expect(view!.windowPid).toBe(900)
    expect(view!.workspaceFolder).toBe('p:\\proj\\alpha')
    expect(view!.bridgeSessionId).toBe('session_01x')
  })

  it('carries the registry entrypoint, so the app can tell an extension session from a CLI one', () => {
    // The tab focus URI may go only to a session running in the VS Code extension: for a CLI session
    // the extension would open a NEW tab.
    const store = new SessionStore()
    store.applySnapshot([live('s1', { entrypoint: 'claude-vscode' }), live('s2', { entrypoint: 'cli' }), live('s3')], noActivity)
    const byId = new Map(store.views().map((v) => [v.sessionId, v]))
    expect(byId.get('s1')!.entrypoint).toBe('claude-vscode')
    expect(byId.get('s2')!.entrypoint).toBe('cli')
    expect(byId.get('s3')!.entrypoint).toBeUndefined()
  })

  it('carries the messaging pipe and the senders a session works for, unchanged', () => {
    // The desktop app links a sender to its recipients by comparing the two, so neither may be reshaped.
    const pipe = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
    const store = new SessionStore()
    store.applySnapshot(
      [live('s1', { messagingSocketPath: pipe }), live('s2')],
      new Map([['s2', { runningTool: 'Bash', promptedBy: [{ pipe, name: 'alpha-01' }] }]]),
    )
    const byId = new Map(store.views().map((v) => [v.sessionId, v]))
    expect(byId.get('s1')!.messagingSocketPath).toBe(pipe)
    expect(byId.get('s2')!.messagingSocketPath).toBeUndefined()
    expect(byId.get('s2')!.activity.promptedBy).toEqual([{ pipe, name: 'alpha-01' }])
  })

  it('falls back to the directory name when the session has no name', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1', { name: undefined })], noActivity)
    expect(store.views()[0]!.name).toBe('alpha')
  })

  it('reports working while a tool is running', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]))
    expect(store.views()[0]!.status).toBe('working')
  })

  it('reports idle with no tool running', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], new Map([['s1', { lastAssistantText: 'kész' }]]))
    expect(store.views()[0]!.status).toBe('idle')
  })

  it('passes the tab title through to the view unchanged', () => {
    // The desktop app matches it against the VS Code window title, so nothing may reshape it.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], new Map([['s1', { lastAssistantText: 'kész', tabTitle: 'Parser munka…' }]]))
    expect(store.views()[0]!.activity.tabTitle).toBe('Parser munka…')
  })

  it('reports waiting after a permission_prompt notification', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification(
      { sessionId: 's1', cwd: 'c', type: 'permission_prompt', text: 'run pnpm test?' },
      5_000,
    )
    const [view] = store.views()
    expect(view!.status).toBe('waiting')
    expect(view!.waitingSince).toBe(5_000)
    expect(view!.notificationText).toBe('run pnpm test?')
  })

  it('treats agent_needs_input as waiting too', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'agent_needs_input' }, 1)
    expect(store.views()[0]!.status).toBe('waiting')
  })

  it('keeps waiting even when a later snapshot shows a running tool', () => {
    // The snapshot comes from the transcript and can lag behind; the hook is the authoritative signal.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1)
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]))
    expect(store.views()[0]!.status).toBe('waiting')
  })

  it('clears waiting on a stop lifecycle event', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' })
    const [view] = store.views()
    expect(view!.status).toBe('idle')
    expect(view!.waitingSince).toBeUndefined()
  })

  it('drops a session that has left the snapshot', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2')], noActivity)
    store.applySnapshot([live('s2')], noActivity)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s2'])
  })

  it('lists the sessions by session id, whatever order the snapshot has', () => {
    // A fixed order keeps an unchanged state serialising identically (the identical-snapshot filter).
    const store = new SessionStore()
    store.applySnapshot([live('s3'), live('s1'), live('s2')], noActivity)
    store.applyNotification({ sessionId: 's2', cwd: 'c', type: 'permission_prompt' }, 100)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s1', 's2', 's3'])
    store.applySnapshot([live('s2'), live('s3'), live('s1')], noActivity)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s1', 's2', 's3'])
  })

  it('notifies listeners when state changes', () => {
    const store = new SessionStore()
    const listener = vi.fn()
    store.onChange(listener)
    store.applySnapshot([live('s1')], noActivity)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores notifications for unknown sessions', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 'ghost', cwd: 'c', type: 'permission_prompt' }, 1)
    expect(store.views()).toHaveLength(1)
    expect(store.views()[0]!.status).toBe('idle')
  })

  it('keeps a notification that arrived before its session was scanned', () => {
    // The hook arrives at once, but the session registry is read every 3 seconds. If the wait were
    // dropped while the session is unknown, the user would see a session WAITING for them as idle:
    // exactly what this app exists for.
    const store = new SessionStore()
    store.applySnapshot([], noActivity, 1000)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1000)
    // Until the session is known it does not show either: views() iterates over the sessions.
    expect(store.views()).toHaveLength(0)

    store.applySnapshot([live('s1')], noActivity, 2000)
    expect(store.views()[0]!.status).toBe('waiting')
    expect(store.views()[0]!.waitingSince).toBe(1000)
  })

  it('drops an unmatched notification once the grace period has passed', () => {
    // Without this the wait of a session that never shows up would stay in memory forever, and a
    // reused id would look "waiting" at once.
    const store = new SessionStore()
    store.applyNotification({ sessionId: 'ghost', cwd: 'c', type: 'permission_prompt' }, 1000)
    store.applySnapshot([], noActivity, 1000 + 11_000)
    store.applySnapshot([live('ghost')], noActivity, 1000 + 11_001)
    expect(store.views()[0]!.status).toBe('idle')
  })

  it('marks a session waiting while a decision is held, before any Notification', () => {
    // The Notification comes only after about 6 s of waiting (measured); the PermissionRequest at once.
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2')], noActivity)
    store.applyPending(new Map([['s2', 500]]), 500)
    const views = store.views()
    const s2 = views.find((v) => v.sessionId === 's2')
    expect(s2?.status).toBe('waiting')
    expect(s2?.waitingSince).toBe(500)
    expect(views.find((v) => v.sessionId === 's1')?.status).toBe('idle')
  })
})

/** The measured order: PermissionRequest → about 6 s → Notification permission_prompt → decision. */
function heldAndNotified(store: SessionStore, sessionId: string, at: number): void {
  store.applyPending(new Map([[sessionId, at]]), at)
  store.applyNotification(
    { sessionId, cwd: 'c', type: 'permission_prompt', text: 'Claude needs your permission to use Bash' },
    at + 6_000,
  )
}

describe('SessionStore: the end of a wait', () => {
  it('clears the Notification-wait when the app resolves the decision', () => {
    // Measured live: after the decision the row stayed "waiting" until the Stop, and its text changed
    // to "Claude needs your permission to use Bash".
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)

    store.applyPending(new Map(), 9_000, 's1')
    const [view] = store.views()
    expect(view?.status).toBe('idle')
    expect(view?.waitingSince).toBeUndefined()
    expect(view?.notificationText).toBeUndefined()
  })

  it('keeps the Notification-wait when the decision closed without the app (it may be another prompt)', () => {
    // The Stop or the PostToolUse clears it separately; a bare close of the pending decision does not
    // claim that the native prompt is gone.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)

    store.applyPending(new Map(), 9_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('clears the Notification-wait when a tool of the session has run', () => {
    // A PostToolUse means the prompt was answered (VS Code, phone or app).
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1_000)

    store.applyToolFinished('s1', 2_000)
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.notificationText).toBeUndefined()
  })

  it('keeps a session waiting through a still-pending or released decision after a tool has run', () => {
    // A decision released after 590 s stays in the broker (released), so in pendingSince too: the
    // native prompt is still open, so the session is waiting.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)

    store.applyToolFinished('s1', 591_000)
    const [view] = store.views()
    expect(view?.status).toBe('waiting')
    expect(view?.waitingSince).toBe(1_000)
  })

  it('ignores a permission_prompt that arrives within 10 s of the app\'s decision', () => {
    // The race: for a decision within 6 s the Notification comes AFTER the decision, and would otherwise
    // set the already decided session to "waiting" again.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 7_000)
    expect(store.views()[0]?.status).toBe('idle')
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 3_000 + 9_999)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('accepts a permission_prompt again once the 10 s window has passed', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 3_000 + 10_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('lets other waiting Notification types through right after a decision', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'agent_needs_input' }, 4_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('does not suppress a permission_prompt for a session the app did not decide', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2', { name: 'bravo' })], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's2', cwd: 'c', type: 'permission_prompt' }, 4_000)
    expect(store.views().find((v) => v.sessionId === 's2')?.status).toBe('waiting')
  })

  it('clears the Notification-wait in the same change when a request closed by client abort', () => {
    // Measured (2026-10-25): after a native No or Esc no hook comes, only the held connection closes.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)
    const listener = vi.fn()
    store.onChange(listener)

    store.applyPending(new Map(), 9_000, undefined, 's1')
    const [view] = store.views()
    expect(view?.status).toBe('idle')
    expect(view?.notificationText).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not open the late-prompt window after a client abort', () => {
    // The window that swallows the late Notification belongs to the app's decision. After a native
    // answer the Notification of a new prompt is a real wait.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)
    store.applyPending(new Map(), 9_000, undefined, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 10_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('makes an older registry waiting stale after a client abort, like any other closing hook', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1', { status: 'waiting', statusUpdatedAt: 1_500 })], noActivity, 2_000)
    heldAndNotified(store, 's1', 1_000)

    store.applyPending(new Map(), 9_000, undefined, 's1')
    expect(store.views()[0]?.status).toBe('idle')
  })
})

describe('SessionStore: the "just finished" mark (stoppedAt)', () => {
  it('records the time of the last Stop without changing the status values', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)
    expect(store.views()[0]?.stoppedAt).toBe(5_000)
    expect(store.views()[0]?.status).toBe('idle')

    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 8_000)
    expect(store.views()[0]?.stoppedAt).toBe(8_000)
  })

  it('has no stoppedAt for a session that has not stopped', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('clears stoppedAt when a tool starts (PreToolUse)', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2', { name: 'bravo' })], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)
    store.applyLifecycle({ sessionId: 's2', cwd: 'c', kind: 'stop' }, 5_000)

    store.applyToolStarted('s1')
    expect(store.views().find((v) => v.sessionId === 's1')?.stoppedAt).toBeUndefined()
    expect(store.views().find((v) => v.sessionId === 's2')?.stoppedAt).toBe(5_000)
  })

  it('clears stoppedAt when a new decision is held for the session (PermissionRequest)', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)

    store.applyPending(new Map([['s1', 6_000]]), 6_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('clears stoppedAt on a waiting Notification, but not on another type', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'idle_prompt' }, 6_000)
    expect(store.views()[0]?.stoppedAt).toBe(5_000)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'agent_needs_input' }, 7_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('keeps stoppedAt on the late permission_prompt of an already decided request', () => {
    // It is the echo of the old, decided request, not new activity.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 2_000, 's1')
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 3_000)

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 7_000)
    expect(store.views()[0]?.stoppedAt).toBe(3_000)
  })

  it('clears stoppedAt when the snapshot reports a running tool', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)

    store.applySnapshot([live('s1')], new Map([['s1', { lastAssistantText: 'kész' }]]), 6_000)
    expect(store.views()[0]?.stoppedAt).toBe(5_000)
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]), 7_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('forgets stoppedAt when the session ends', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'end' }, 6_000)
    expect(store.views()).toEqual([])

    // If the registry still shows it for one more round, it must not come back as "just finished".
    store.applySnapshot([live('s1')], noActivity, 7_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })
})

/** The registry's status fields (Claude Code 2.1.296+, measured): a waiting record. */
function registryWaiting(sessionId: string, since: number, over: Partial<LiveSession['record']> = {}): LiveSession {
  return live(sessionId, { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: since, ...over })
}

describe('SessionStore: waiting from the registry (after an app restart)', () => {
  it('counts a registry status of waiting as waiting, since statusUpdatedAt', () => {
    // The user's case: the session was already waiting when the app restarted. Neither a
    // PermissionRequest nor a Notification comes any more, only the registry knows.
    const store = new SessionStore()
    store.applySnapshot([live('a', { name: 'alpha' }), registryWaiting('b', 4_000, { name: 'bravo' })], noActivity, 9_000)
    const first = store.views().find((v) => v.sessionId === 'b')
    expect(first?.status).toBe('waiting')
    expect(first?.waitingSince).toBe(4_000)
    expect(first?.notificationText).toBeUndefined()
  })

  it('falls back to the old behaviour when the record has no status or no statusUpdatedAt', () => {
    const store = new SessionStore()
    store.applySnapshot(
      [live('a'), live('b', { status: 'waiting', waitingFor: 'permission prompt' }), live('c', { status: 'weird', statusUpdatedAt: 1 })],
      noActivity,
      9_000,
    )
    expect(store.views().map((v) => v.status)).toEqual(['idle', 'idle', 'idle'])
  })

  it('prefers the hook source for waitingSince when both know the wait', () => {
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_200)], noActivity, 1_300)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    expect(store.views()[0]?.waitingSince).toBe(1_000)
  })

  it('does not resurrect the wait from a lagging snapshot after the app decided', () => {
    // The hook comes at once, the registry is read about every 3 s: the first snapshot after the
    // decision may still show the old "waiting".
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 1_500)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')
    expect(store.views()[0]?.status).toBe('idle')

    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 4_000)
    expect(store.views()[0]?.status).toBe('idle')
    // Not even when the lag lasts longer than the 10 s late prompt window.
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 30_000)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('shows a registry wait that started after the app decided, even inside the late-prompt window', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')
    store.applySnapshot([registryWaiting('s1', 3_500)], noActivity, 5_000)
    expect(store.views()[0]?.status).toBe('waiting')
    expect(store.views()[0]?.waitingSince).toBe(3_500)
  })

  it('clears a registry wait on PostToolUse at once, and a lagging snapshot does not bring it back', () => {
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 1_500)
    store.applyToolFinished('s1', 2_000)
    expect(store.views()[0]?.status).toBe('idle')
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('clears a registry wait on Stop, and a lagging snapshot does not bring it back', () => {
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 1_500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.stoppedAt).toBe(2_000)
  })

  it('clears stoppedAt for a registry wait newer than the Stop, not for a lagging one', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 3_000)
    expect(store.views()[0]?.stoppedAt).toBe(2_000)

    store.applySnapshot([registryWaiting('s1', 2_500)], noActivity, 4_000)
    expect(store.views()[0]?.status).toBe('waiting')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })
})

describe('SessionStore: "busy" from the registry', () => {
  it('reports working for a registry status of busy, also without a running tool', () => {
    // While thinking or streaming text no tool runs; this used to look idle.
    const store = new SessionStore()
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 1_000 })], noActivity, 2_000)
    expect(store.views()[0]?.status).toBe('working')
  })

  it('ignores busy without statusUpdatedAt', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1', { status: 'busy' })], noActivity, 2_000)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('does not count a busy older than the last Stop: the session has just finished', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 1_000 })], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.stoppedAt).toBe(2_000)
  })

  it('clears stoppedAt for a busy newer than the Stop: a new turn has begun', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 2_500 })], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('working')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('keeps a hook wait over a registry busy', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1_000)
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 900 })], noActivity, 2_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })
})

describe('SessionStore: subagents', () => {
  const searching: SubagentView = {
    agentId: 'a1', agentType: 'general-purpose', description: 'Teszt hullám',
    runningTool: 'Grep', toolDetail: 'createPanel', updatedAt: 4_000,
  }
  const thinking: SubagentView = { agentId: 'a2', description: 'Gondolkodó', updatedAt: 3_000 }

  it('carries the active subagents into the view, and nothing when there are none', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2', { name: 'bravo' })], noActivity, 5_000, new Map([['s1', [searching, thinking]]]))
    const byId = new Map(store.views().map((v) => [v.sessionId, v]))
    expect(byId.get('s1')?.subagents).toEqual([searching, thinking])
    expect(byId.get('s2')?.subagents).toBeUndefined()
    expect('subagents' in (byId.get('s2') ?? {})).toBe(false)
  })

  it('reports working while a subagent runs a tool, even after the main Stop', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 1_000)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    expect(store.views()[0]?.status).toBe('idle')

    store.applySnapshot([live('s1')], noActivity, 3_000, new Map([['s1', [searching]]]))
    expect(store.views()[0]?.status).toBe('working')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('does not show "just finished" while a background subagent is active, even between its tools', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 1_000)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([live('s1')], noActivity, 3_000, new Map([['s1', [thinking]]]))
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()

    // A subagent without a tool is no fresh activity: when it disappears, the old Stop shows again.
    store.applySnapshot([live('s1')], noActivity, 4_000)
    expect(store.views()[0]?.stoppedAt).toBe(2_000)
  })

  it('keeps a hook or registry wait over a working subagent', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1_000)
    store.applySnapshot([live('s1')], noActivity, 2_000, new Map([['s1', [searching]]]))
    expect(store.views()[0]?.status).toBe('waiting')

    const other = new SessionStore()
    other.applySnapshot([registryWaiting('s1', 1_500)], noActivity, 2_000, new Map([['s1', [searching]]]))
    expect(other.views()[0]?.status).toBe('waiting')
  })

  it('forgets the subagents of a session once the snapshot no longer has them', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 1_000, new Map([['s1', [searching]]]))
    store.applySnapshot([live('s1')], noActivity, 2_000)
    expect(store.views()[0]?.subagents).toBeUndefined()
    expect(store.views()[0]?.status).toBe('idle')
  })
})
