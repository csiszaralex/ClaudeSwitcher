import { describe, expect, it } from 'vitest'
import { IDLE_TRAY_STATE, trayState, trayTooltip, type TrayDecision, type TraySession } from './tray-state.js'

const idle: TraySession = { status: 'idle' }
const waiting: TraySession = { status: 'waiting' }
const held = (kind: TrayDecision['kind']): TrayDecision => ({ kind, released: false })

describe('trayState', () => {
  it('is idle with nothing waiting', () => {
    expect(trayState({ sessions: [idle, { status: 'working' }], decisions: [] })).toEqual(IDLE_TRAY_STATE)
  })

  it('shows a yes/no wait for a command or an edit request', () => {
    expect(trayState({ sessions: [waiting], decisions: [held('tool')] }).wait).toBe('yes-no')
    expect(trayState({ sessions: [waiting], decisions: [held('edit')] }).wait).toBe('yes-no')
  })

  it('shows a Notification wait without a held request as yes/no', () => {
    expect(trayState({ sessions: [waiting], decisions: [] })).toEqual({ waitingCount: 1, wait: 'yes-no' })
  })

  it('shows a choice wait when any held request is a question or a plan', () => {
    const state = trayState({ sessions: [waiting, waiting], decisions: [held('tool'), held('plan')] })
    expect(state).toEqual({ waitingCount: 2, wait: 'choice' })
    expect(trayState({ sessions: [waiting], decisions: [held('question')] }).wait).toBe('choice')
  })

  it('ignores a released choice request', () => {
    const state = trayState({ sessions: [waiting], decisions: [{ kind: 'question', released: true }, held('edit')] })
    expect(state.wait).toBe('yes-no')
  })
})

describe('trayTooltip', () => {
  it('is the app name alone when nothing waits', () => {
    expect(trayTooltip(IDLE_TRAY_STATE)).toBe('ClaudeSwitcher')
  })

  it('keeps the count wording, and adds the choice', () => {
    expect(trayTooltip({ waitingCount: 2, wait: 'yes-no' })).toBe('ClaudeSwitcher: 2 session vár rád')
    expect(trayTooltip({ waitingCount: 1, wait: 'choice' })).toBe('ClaudeSwitcher: 1 session vár rád, választásra vár')
  })
})
