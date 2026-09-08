import type { LiveSession, SessionActivity } from '@claudeswitcher/core'
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
    expect(view!.windowPid).toBe(900)
    expect(view!.workspaceFolder).toBe('p:\\proj\\alpha')
    expect(view!.bridgeSessionId).toBe('session_01x')
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
    // A snapshot a transcriptből jön és lemaradhat; a hook a mérvadó jelzés.
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

  it('sorts waiting sessions first, oldest wait at the top', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2'), live('s3')], noActivity)
    store.applyNotification({ sessionId: 's2', cwd: 'c', type: 'permission_prompt' }, 200)
    store.applyNotification({ sessionId: 's3', cwd: 'c', type: 'permission_prompt' }, 100)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s3', 's2', 's1'])
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
})
