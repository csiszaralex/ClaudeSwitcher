import { describe, expect, it } from 'vitest'
import { PERMISSION_RELEASE_AFTER_MS } from '@claudeswitcher/core'
import {
  IDLE_TRAY_STATE,
  PERMISSION_WARN_AFTER_MS,
  acknowledgeFinish,
  trayState,
  trayTooltip,
  type TrayDecision,
  type TrayInput,
  type TraySession,
} from './tray-state.js'

const idle: TraySession = { sessionId: '6f1c2a3e-0000-4000-8000-000000000001', status: 'idle' }
const waiting: TraySession = { sessionId: '6f1c2a3e-0000-4000-8000-000000000002', status: 'waiting' }
const finished = (stoppedAt: number): TraySession => ({
  sessionId: '6f1c2a3e-0000-4000-8000-000000000003',
  status: 'idle',
  stoppedAt,
})
/** An invented clock: the requests below were created at `NOW` unless a test says otherwise. */
const NOW = 1_800_000_000_000
const held = (kind: TrayDecision['kind'], createdAt = NOW): TrayDecision => ({ kind, released: false, createdAt })

/** The input at `NOW`, with nothing acknowledged unless given. */
function input(sessions: TraySession[], decisions: TrayDecision[], acknowledged = new Map<string, number>()): TrayInput {
  return { sessions, decisions, acknowledged, now: NOW }
}

describe('trayState', () => {
  it('is idle with nothing waiting', () => {
    expect(trayState(input([idle, { ...idle, status: 'working' }], []))).toEqual(IDLE_TRAY_STATE)
  })

  it('shows a yes/no wait for a command or an edit request', () => {
    expect(trayState(input([waiting], [held('tool')])).wait).toBe('yes-no')
    expect(trayState(input([waiting], [held('edit')])).wait).toBe('yes-no')
  })

  it('shows a Notification wait without a held request as yes/no', () => {
    expect(trayState(input([waiting], []))).toEqual({ waitingCount: 1, wait: 'yes-no', finishedCount: 0, flash: false })
  })

  it('shows a choice wait when any held request is a question or a plan', () => {
    const state = trayState(input([waiting, waiting], [held('tool'), held('plan')]))
    expect(state).toEqual({ waitingCount: 2, wait: 'choice', finishedCount: 0, flash: false })
    expect(trayState(input([waiting], [held('question')])).wait).toBe('choice')
  })

  it('ignores a released choice request', () => {
    const state = trayState(input([waiting], [{ kind: 'question', released: true, createdAt: NOW }, held('edit')]))
    expect(state.wait).toBe('yes-no')
  })
})

describe('trayState: finished sessions', () => {
  it('counts a finished session nobody has seen', () => {
    expect(trayState(input([finished(5_000), idle], []))).toEqual({ waitingCount: 0, wait: 'none', finishedCount: 1, flash: false })
  })

  it('counts it next to a waiting one', () => {
    expect(trayState(input([finished(5_000), waiting], [held('tool')]))).toEqual({
      waitingCount: 1,
      wait: 'yes-no',
      finishedCount: 1,
      flash: false,
    })
  })

  it('does not count a session that runs again next to a stale stoppedAt', () => {
    const working: TraySession = { ...finished(5_000), status: 'working' }
    expect(trayState(input([working], [])).finishedCount).toBe(0)
  })

  it('does not count an acknowledged finish', () => {
    const acknowledged = new Map<string, number>()
    acknowledgeFinish(acknowledged, finished(5_000))
    expect(trayState(input([finished(5_000)], [], acknowledged)).finishedCount).toBe(0)
  })

  it('counts the next finish of an acknowledged session again: a new stoppedAt', () => {
    const acknowledged = new Map<string, number>()
    acknowledgeFinish(acknowledged, finished(5_000))
    expect(trayState(input([finished(9_000)], [], acknowledged)).finishedCount).toBe(1)
  })

  it('acknowledges nothing for a session without a stoppedAt', () => {
    const acknowledged = new Map<string, number>()
    acknowledgeFinish(acknowledged, idle)
    expect(acknowledged.size).toBe(0)
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
    const released: TrayDecision = { kind: 'tool', released: true, createdAt: NOW - 2 * PERMISSION_WARN_AFTER_MS }
    expect(trayState(input([waiting], [released])).flash).toBe(false)
  })
})

describe('trayTooltip', () => {
  it('is the app name alone when nothing waits', () => {
    expect(trayTooltip(IDLE_TRAY_STATE)).toBe('ClaudeSwitcher')
  })

  it('keeps the count wording, and adds the choice', () => {
    expect(trayTooltip({ waitingCount: 2, wait: 'yes-no', finishedCount: 0, flash: false })).toBe('ClaudeSwitcher: 2 session vár rád')
    expect(trayTooltip({ waitingCount: 1, wait: 'choice', finishedCount: 0, flash: false })).toBe(
      'ClaudeSwitcher: 1 session vár rád, választásra vár',
    )
  })

  it('adds the unseen finishes', () => {
    expect(trayTooltip({ waitingCount: 0, wait: 'none', finishedCount: 2, flash: false })).toBe('ClaudeSwitcher: 2 végzett')
    expect(trayTooltip({ waitingCount: 1, wait: 'yes-no', finishedCount: 1, flash: false })).toBe(
      'ClaudeSwitcher: 1 session vár rád, 1 végzett',
    )
  })
})
