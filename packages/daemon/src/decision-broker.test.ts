import { readFileSync } from 'node:fs'
import { parsePermissionRequest, type HookDecisionBody, type PermissionRequestInfo } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import {
  DecisionBroker,
  RELEASE_AFTER_MS,
  type BrokerClock,
  type ToolUseEvent,
} from './decision-broker.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../../core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>

function payload(name: string): Record<string, unknown> {
  const value = fixtures[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function request(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(payload(name))
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return info
}

function toolUse(name: string): ToolUseEvent {
  const body = payload(name)
  const sessionId = body['session_id']
  const toolName = body['tool_name']
  const toolUseId = body['tool_use_id']
  const toolInput = body['tool_input']
  if (
    typeof sessionId !== 'string' ||
    typeof toolName !== 'string' ||
    typeof toolUseId !== 'string' ||
    typeof toolInput !== 'object' ||
    toolInput === null
  ) {
    throw new Error(`not a tool-use fixture: ${name}`)
  }
  return { sessionId, toolName, toolInput: toolInput as Record<string, unknown>, toolUseId }
}

/** Hamis óra: a 590 mp-et nem kell kivárni, és az időzítők determinisztikusan futnak. */
function fakeClock(): BrokerClock & { advance(ms: number): void } {
  let now = 1_000
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') timers.delete(handle)
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
  }
}

/** Egy tartott kérés megfigyelése: megkapta-e már a választ, és mit. */
function observe(promise: Promise<HookDecisionBody | undefined>): { done: boolean; value: HookDecisionBody | undefined } {
  const state: { done: boolean; value: HookDecisionBody | undefined } = { done: false, value: undefined }
  void promise.then((value) => {
    state.done = true
    state.value = value
  })
  return state
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('DecisionBroker', () => {
  it('holds a request and answers it with the user\'s decision', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_bash')))
    const [view] = broker.views()
    expect(view?.kind).toBe('tool')
    expect(view?.released).toBe(false)

    expect(broker.decide(view!.id, { type: 'allow' })).toEqual({ ok: true })
    await flush()
    expect(held.done).toBe(true)
    expect(held.value?.hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(broker.views()).toEqual([])
  })

  it('refuses an invalid decision and keeps the request pending', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_plan')))
    const [view] = broker.views()

    const result = broker.decide(view!.id, { type: 'allow' })
    expect(result.ok).toBe(false)
    await flush()
    expect(held.done).toBe(false)
    expect(broker.views()).toHaveLength(1)
  })

  it('answers each request exactly once — a second decision is refused', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_bash')))
    const [view] = broker.views()

    expect(broker.decide(view!.id, { type: 'deny', message: 'nem' }).ok).toBe(true)
    expect(broker.decide(view!.id, { type: 'allow' }).ok).toBe(false)
    await flush()
    expect(held.value?.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'nem' })
  })

  it('recognises a decision made in VS Code by the PostToolUse of the same call', async () => {
    // A fixture-hármas egyetlen hívás három hookja — mérve, nem kitalálva.
    const broker = new DecisionBroker(fakeClock())
    broker.preToolUse(toolUse('preToolUse_bash'))
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse(toolUse('postToolUse_bash'))
    await flush()
    expect(held.done).toBe(true)
    expect(held.value).toBeUndefined()
    expect(broker.views()).toEqual([])
  })

  it('ignores a PostToolUse of a different call', async () => {
    const broker = new DecisionBroker(fakeClock())
    broker.preToolUse(toolUse('preToolUse_bash'))
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse({ sessionId: toolUse('postToolUse_bash').sessionId, toolUseId: 'toolu_other' })
    await flush()
    expect(held.done).toBe(false)
  })

  it('still correlates when the PreToolUse arrives after the PermissionRequest', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))
    broker.preToolUse(toolUse('preToolUse_bash'))

    broker.postToolUse(toolUse('postToolUse_bash'))
    await flush()
    expect(held.done).toBe(true)
  })

  it('does not attach a PreToolUse older than a minute', async () => {
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    broker.preToolUse(toolUse('preToolUse_bash'))
    clock.advance(61_000)
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse(toolUse('postToolUse_bash'))
    await flush()
    expect(held.done).toBe(false)
  })

  it('releases at 590 s with no decision, keeps the row, and refuses a late click', async () => {
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    const held = observe(broker.hold(request('permissionRequest_bash')))
    const [view] = broker.views()

    clock.advance(RELEASE_AFTER_MS - 1)
    await flush()
    expect(held.done).toBe(false)

    clock.advance(1)
    await flush()
    expect(held.done).toBe(true)
    expect(held.value).toBeUndefined()
    // A natív prompt ott maradt, tehát a sor is — de onnan már csak a VSCode dönthet.
    expect(broker.views()[0]?.released).toBe(true)
    expect(broker.decide(view!.id, { type: 'allow' }).ok).toBe(false)

    broker.sessionStopped(view!.sessionId)
    expect(broker.views()).toEqual([])
  })

  it('closes only the session that stopped', async () => {
    const broker = new DecisionBroker(fakeClock())
    const mine = observe(broker.hold(request('permissionRequest_bash')))
    const other = observe(broker.hold({ ...request('permissionRequest_bash'), sessionId: 'other-session' }))

    broker.sessionStopped(request('permissionRequest_bash').sessionId)
    await flush()
    expect(mine.done).toBe(true)
    expect(other.done).toBe(false)
    expect(broker.views().map((v) => v.sessionId)).toEqual(['other-session'])
  })

  it('closes a subagent\'s request on its SubagentStop, not the parent\'s', async () => {
    // A subagent a szülő session_id-jával jön — csak az agent_id különbözteti meg.
    const broker = new DecisionBroker(fakeClock())
    const parent = observe(broker.hold(request('permissionRequest_bash')))
    const subagent = observe(broker.hold(request('permissionRequest_subagent')))

    const stop = payload('subagentStop')
    broker.subagentStopped(String(stop['session_id']), String(stop['agent_id']))
    await flush()
    expect(subagent.done).toBe(true)
    expect(parent.done).toBe(false)
  })

  it('answers every held request on releaseAll', async () => {
    const broker = new DecisionBroker(fakeClock())
    const first = observe(broker.hold(request('permissionRequest_bash')))
    const second = observe(broker.hold(request('permissionRequest_webFetch')))

    broker.releaseAll()
    await flush()
    expect([first.done, second.done]).toEqual([true, true])
    expect([first.value, second.value]).toEqual([undefined, undefined])
    expect(broker.views()).toEqual([])
  })

  it('notifies listeners on every change', () => {
    const broker = new DecisionBroker(fakeClock())
    const listener = vi.fn()
    broker.onChange(listener)

    void broker.hold(request('permissionRequest_bash'))
    expect(listener).toHaveBeenCalledTimes(1)
    broker.decide(broker.views()[0]!.id, { type: 'allow' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
