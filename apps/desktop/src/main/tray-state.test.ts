import { describe, expect, it } from 'vitest'
import { PERMISSION_RELEASE_AFTER_MS } from '@claudeswitcher/core'
import {
  IDLE_TRAY_STATE,
  PERMISSION_WARN_AFTER_MS,
  trayState,
  trayTooltip,
  type TrayDecision,
  type TrayInput,
  type TraySession,
} from './tray-state.js'
import { acknowledgeFinish, clearFinish, type SeenFinish } from '../shared/session-finished.js'

const idle: TraySession = { sessionId: '6f1c2a3e-0000-4000-8000-000000000001', status: 'idle' }
const waiting: TraySession = { sessionId: '6f1c2a3e-0000-4000-8000-000000000002', status: 'waiting' }
const finished = (stoppedAt: number): TraySession => ({
  sessionId: '6f1c2a3e-0000-4000-8000-000000000003',
  status: 'idle',
  stoppedAt,
})
/** An invented clock: the requests below were created at `NOW` unless a test says otherwise. */
const NOW = 1_800_000_000_000
/** A request of the `waiting` session unless a test says otherwise. */
const held = (kind: TrayDecision['kind'], createdAt = NOW, sessionId = waiting.sessionId): TrayDecision => ({
  sessionId,
  kind,
  released: false,
  createdAt,
})
const released = (kind: TrayDecision['kind'], sessionId = waiting.sessionId): TrayDecision => ({
  ...held(kind, NOW, sessionId),
  released: true,
})
const working: TraySession = { sessionId: '6f1c2a3e-0000-4000-8000-000000000005', status: 'working' }

/** The input at `NOW`, with nothing acknowledged unless given. */
function input(sessions: TraySession[], decisions: TrayDecision[], acknowledged = new Map<string, SeenFinish>()): TrayInput {
  return { sessions, decisions, acknowledged, now: NOW }
}

describe('trayState', () => {
  it('is idle with nothing waiting or working', () => {
    expect(trayState(input([idle], []))).toEqual(IDLE_TRAY_STATE)
  })

  it('shows a yes/no wait for a command or an edit request', () => {
    expect(trayState(input([waiting], [held('tool')])).wait).toBe('yes-no')
    expect(trayState(input([waiting], [held('edit')])).wait).toBe('yes-no')
  })

  it('shows a Notification wait without a held request as yes/no', () => {
    expect(trayState(input([waiting], []))).toEqual({ ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'yes-no' })
  })

  it('shows a choice wait when any held request is a question or a plan', () => {
    const state = trayState(input([waiting, waiting], [held('tool'), held('plan')]))
    expect(state).toEqual({ ...IDLE_TRAY_STATE, waitingCount: 2, wait: 'choice' })
    expect(trayState(input([waiting], [held('question')])).wait).toBe('choice')
  })

  it('ignores a released choice request', () => {
    const state = trayState(input([waiting], [released('question'), held('edit')]))
    expect(state.wait).toBe('yes-no')
  })

  it('counts held requests whose session is not known yet, as the list shows them', () => {
    expect(trayState(input([], [held('plan', NOW, '6f1c2a3e-0000-4000-8000-0000000000ff')])).wait).toBe('choice')
    expect(trayState(input([], [released('tool', '6f1c2a3e-0000-4000-8000-0000000000ff')])).wait).toBe('released')
  })
})

describe('trayState: released requests', () => {
  it('shows a session whose requests are all released as released, though it still waits', () => {
    expect(trayState(input([waiting], [released('tool')]))).toEqual({ ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'released' })
    expect(trayState(input([waiting], [released('question'), released('edit')])).wait).toBe('released')
  })

  it('lets a request the app can decide win over a released one in another session', () => {
    const other: TraySession = { ...waiting, sessionId: '6f1c2a3e-0000-4000-8000-000000000006' }
    expect(trayState(input([waiting, other], [released('tool'), held('edit', NOW, other.sessionId)])).wait).toBe('yes-no')
    expect(trayState(input([waiting, other], [released('tool'), held('plan', NOW, other.sessionId)])).wait).toBe('choice')
  })

  it('lets a Notification wait without a request win over a released one in another session', () => {
    const other: TraySession = { ...waiting, sessionId: '6f1c2a3e-0000-4000-8000-000000000006' }
    expect(trayState(input([waiting, other], [released('tool')])).wait).toBe('yes-no')
  })
})

describe('trayState: working sessions', () => {
  it('counts the working sessions', () => {
    const second: TraySession = { ...working, sessionId: '6f1c2a3e-0000-4000-8000-000000000007' }
    expect(trayState(input([working, second, idle], []))).toEqual({ ...IDLE_TRAY_STATE, workingCount: 2 })
  })

  it('counts a working session next to a waiting one, but the wait stays', () => {
    expect(trayState(input([working, waiting], [held('tool')]))).toEqual({
      ...IDLE_TRAY_STATE,
      waitingCount: 1,
      wait: 'yes-no',
      workingCount: 1,
    })
  })

  it('does not count a waiting session as working', () => {
    expect(trayState(input([waiting], [])).workingCount).toBe(0)
  })

  it('counts a finished session that waits on a session it prompted as working, not finished', () => {
    // An invented pipe in the measured shape (design doc "Cross-session messages").
    const pipe = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
    const sender: TraySession = { ...finished(5_000), messagingSocketPath: pipe }
    const recipient = (status: TraySession['status']): TraySession => ({ ...working, status, activity: { promptedBy: [{ pipe }] } })
    expect(trayState(input([sender, recipient('working')], []))).toEqual({ ...IDLE_TRAY_STATE, workingCount: 2 })
    expect(trayState(input([sender, recipient('idle')], []))).toEqual({ ...IDLE_TRAY_STATE, finishedCount: 1 })
  })
})

describe('trayState: finished sessions', () => {
  it('counts a finished session nobody has seen', () => {
    expect(trayState(input([finished(5_000), idle], []))).toEqual({ ...IDLE_TRAY_STATE, finishedCount: 1 })
  })

  it('counts it next to a waiting one', () => {
    expect(trayState(input([finished(5_000), waiting], [held('tool')]))).toEqual({
      ...IDLE_TRAY_STATE,
      waitingCount: 1,
      wait: 'yes-no',
      finishedCount: 1,
    })
  })

  it('does not count a session that runs again next to a stale stoppedAt', () => {
    const again: TraySession = { ...finished(5_000), status: 'working' }
    expect(trayState(input([again], [])).finishedCount).toBe(0)
  })

  it('does not count an acknowledged finish', () => {
    const acknowledged = new Map<string, SeenFinish>()
    acknowledgeFinish(acknowledged, finished(5_000), [])
    expect(trayState(input([finished(5_000)], [], acknowledged)).finishedCount).toBe(0)
  })

  it('counts the next finish of an acknowledged session again: a new stoppedAt', () => {
    const acknowledged = new Map<string, SeenFinish>()
    acknowledgeFinish(acknowledged, finished(5_000), [])
    expect(trayState(input([finished(9_000)], [], acknowledged)).finishedCount).toBe(1)
  })

  it('counts only the unseen finish among a seen and an unseen one: the green ✓ rows of the list', () => {
    const other: TraySession = { ...finished(7_000), sessionId: '6f1c2a3e-0000-4000-8000-000000000004' }
    const acknowledged = new Map<string, SeenFinish>()
    acknowledgeFinish(acknowledged, finished(5_000), [])
    expect(trayState(input([finished(5_000), other], [], acknowledged)).finishedCount).toBe(1)
  })

  it('does not count a cleared finish, and counts the next one', () => {
    const acknowledged = new Map<string, SeenFinish>()
    clearFinish(acknowledged, finished(5_000), [])
    expect(trayState(input([finished(5_000)], [], acknowledged)).finishedCount).toBe(0)
    expect(trayState(input([finished(9_000)], [], acknowledged)).finishedCount).toBe(1)
  })
})

describe('trayState: the flash before the release', () => {
  it('warns 50 s before the release, at 540 s', () => {
    expect(PERMISSION_WARN_AFTER_MS).toBe(540_000)
    expect(PERMISSION_RELEASE_AFTER_MS - PERMISSION_WARN_AFTER_MS).toBe(50_000)
  })

  it('does not flash at the warning time itself', () => {
    expect(trayState(input([waiting], [held('tool', NOW - PERMISSION_WARN_AFTER_MS)])).flash).toBe(false)
  })

  it('flashes once a held request is older than the warning time', () => {
    expect(trayState(input([waiting], [held('tool', NOW - PERMISSION_WARN_AFTER_MS - 1)])).flash).toBe(true)
  })

  it('flashes for one old request among young ones', () => {
    const decisions = [held('edit'), held('question', NOW - PERMISSION_WARN_AFTER_MS - 1_000)]
    expect(trayState(input([waiting, waiting], decisions)).flash).toBe(true)
  })

  it('does not flash for a released request, however old', () => {
    const old: TrayDecision = { ...released('tool'), createdAt: NOW - 2 * PERMISSION_WARN_AFTER_MS }
    expect(trayState(input([waiting], [old])).flash).toBe(false)
  })
})

describe('trayTooltip', () => {
  it('is the app name alone when nothing waits', () => {
    expect(trayTooltip(IDLE_TRAY_STATE)).toBe('ClaudeSwitcher')
  })

  it('keeps the count wording, and adds the choice', () => {
    expect(trayTooltip({ ...IDLE_TRAY_STATE, waitingCount: 2, wait: 'yes-no' })).toBe('ClaudeSwitcher: 2 session vár rád')
    expect(trayTooltip({ ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'choice' })).toBe(
      'ClaudeSwitcher: 1 session vár rád, választásra vár',
    )
  })

  it('adds the unseen finishes', () => {
    expect(trayTooltip({ ...IDLE_TRAY_STATE, finishedCount: 2 })).toBe('ClaudeSwitcher: 2 végzett')
    expect(trayTooltip({ ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'yes-no', finishedCount: 1 })).toBe(
      'ClaudeSwitcher: 1 session vár rád, 1 végzett',
    )
  })

  it('names a released wait, and adds the working sessions last', () => {
    expect(trayTooltip({ ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'released' })).toBe(
      'ClaudeSwitcher: 1 session vár rád, az app elengedte',
    )
    expect(trayTooltip({ ...IDLE_TRAY_STATE, finishedCount: 1, workingCount: 2 })).toBe('ClaudeSwitcher: 1 végzett, 2 dolgozik')
  })
})
