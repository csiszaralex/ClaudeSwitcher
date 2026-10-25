import { readFileSync } from 'node:fs'
import { parsePermissionRequest, type HookDecisionBody, type PermissionRequestInfo } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import {
  ABSENT_SESSION_GRACE_MS,
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

  it('closes a natively allowed request whose tool then failed (PostToolUseFailure)', async () => {
    // A konstruált fixture a mért preToolUse_bash hívás hibás vége: ugyanaz a tool_use_id.
    const broker = new DecisionBroker(fakeClock())
    broker.preToolUse(toolUse('preToolUse_bash'))
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse(toolUse('postToolUseFailure_bash_constructed'))
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

  it('keeps a background subagent\'s request open on the main turn\'s Stop, and closes it on SessionEnd', async () => {
    // A `run_in_background` subagent a fő kör Stop-ja után is fut; a kérése a szülő session_id-jával jön.
    const broker = new DecisionBroker(fakeClock())
    const main = observe(broker.hold(request('permissionRequest_bash')))
    const subagent = observe(broker.hold(request('permissionRequest_subagent')))
    const sessionId = request('permissionRequest_bash').sessionId
    expect(request('permissionRequest_subagent').sessionId).toBe(sessionId)

    broker.sessionStopped(sessionId)
    await flush()
    expect(main.done).toBe(true)
    expect(subagent.done).toBe(false)
    expect(broker.views().map((v) => v.agentId)).toEqual([request('permissionRequest_subagent').agentId])

    broker.sessionEnded(sessionId)
    await flush()
    expect(subagent.done).toBe(true)
    expect(subagent.value).toBeUndefined()
    expect(broker.views()).toEqual([])
  })

  it('finishes a request without an answer when its hook client disconnects', async () => {
    const broker = new DecisionBroker(fakeClock())
    const client = new AbortController()
    const held = observe(broker.hold(request('permissionRequest_bash'), client.signal))
    const [view] = broker.views()

    client.abort()
    await flush()
    expect(held.done).toBe(true)
    expect(held.value).toBeUndefined()
    expect(broker.views()).toEqual([])
    // Az „pontosan egy válasz" zár: a késő kattintás már nem talál semmit.
    expect(broker.decide(view!.id, { type: 'allow' }).ok).toBe(false)
  })

  it('does not hold a request whose client is already gone', async () => {
    const broker = new DecisionBroker(fakeClock())
    const client = new AbortController()
    client.abort()
    const held = observe(broker.hold(request('permissionRequest_bash'), client.signal))
    await flush()
    expect(held.done).toBe(true)
    expect(broker.views()).toEqual([])
  })

  it('prunes a released request once its session has been gone from the registry past the grace period', () => {
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    const gone = request('permissionRequest_bash')
    void broker.hold(gone)
    void broker.hold({ ...gone, sessionId: 'alive' })
    clock.advance(RELEASE_AFTER_MS)
    expect(broker.views().every((v) => v.released)).toBe(true)

    const live = new Set(['alive'])
    broker.pruneAbsent(live)
    clock.advance(ABSENT_SESSION_GRACE_MS - 1)
    broker.pruneAbsent(live)
    expect(broker.views()).toHaveLength(2)

    clock.advance(1)
    broker.pruneAbsent(live)
    expect(broker.views().map((v) => v.sessionId)).toEqual(['alive'])
  })

  it('restarts the grace period when the session shows up in the registry again', () => {
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    const held = request('permissionRequest_bash')
    void broker.hold(held)
    clock.advance(RELEASE_AFTER_MS)

    broker.pruneAbsent(new Set())
    clock.advance(ABSENT_SESSION_GRACE_MS - 1)
    // Egy kimaradt szkennelés után újra ott van: a session él.
    broker.pruneAbsent(new Set([held.sessionId]))
    clock.advance(ABSENT_SESSION_GRACE_MS - 1)
    broker.pruneAbsent(new Set())
    expect(broker.views()).toHaveLength(1)
  })

  it('never prunes a request the app can still decide, even if discovery does not see its session', async () => {
    // Spec §8: a jóváhagyás a felderítés nélkül is működik. A még döntható kérést a kliens
    // bontása (a processz halála) zárja le, nem a registry hiánya.
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    const held = observe(broker.hold(request('permissionRequest_bash')))
    broker.pruneAbsent(new Set())
    clock.advance(ABSENT_SESSION_GRACE_MS * 10)
    broker.pruneAbsent(new Set())
    await flush()
    expect(held.done).toBe(false)
    expect(broker.views()).toHaveLength(1)
  })

  it('matches identical parallel calls oldest-first when both PreToolUses come first', async () => {
    // Mért sorrend: PreToolUse, majd ~15 ms-mal később a PermissionRequest. Két azonos hívásnál:
    // Pre(id1), Pre(id2), A, B — az A az id1-é.
    const broker = new DecisionBroker(fakeClock())
    const pre = toolUse('preToolUse_bash')
    broker.preToolUse({ ...pre, toolUseId: 'toolu_1' })
    broker.preToolUse({ ...pre, toolUseId: 'toolu_2' })
    const first = observe(broker.hold(request('permissionRequest_bashCorrelated')))
    const second = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse({ sessionId: pre.sessionId, toolUseId: 'toolu_1' })
    await flush()
    expect([first.done, second.done]).toEqual([true, false])
  })

  it('matches identical parallel calls oldest-first when they interleave', async () => {
    const broker = new DecisionBroker(fakeClock())
    const pre = toolUse('preToolUse_bash')
    broker.preToolUse({ ...pre, toolUseId: 'toolu_1' })
    const first = observe(broker.hold(request('permissionRequest_bashCorrelated')))
    broker.preToolUse({ ...pre, toolUseId: 'toolu_2' })
    const second = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse({ sessionId: pre.sessionId, toolUseId: 'toolu_2' })
    await flush()
    expect([first.done, second.done]).toEqual([false, true])
    broker.postToolUse({ sessionId: pre.sessionId, toolUseId: 'toolu_1' })
    await flush()
    expect(first.done).toBe(true)
  })

  it('keeps the main agent and a subagent apart when they run the same command in parallel', async () => {
    // A subagent a szülő session_id-jával jön, csak az agent_id különbözteti meg. Pre(fő),
    // Pre(sub), majd a sub kérése érkezik elsőnek: agent_id nélkül a fő hívás azonosítóját vinné el.
    const broker = new DecisionBroker(fakeClock())
    const pre = toolUse('preToolUse_bash')
    const subagentId = request('permissionRequest_subagent').agentId
    expect(subagentId).toBe(payload('subagentStop')['agent_id'])
    broker.preToolUse({ ...pre, toolUseId: 'toolu_main' })
    broker.preToolUse({ ...pre, agentId: subagentId, toolUseId: 'toolu_sub' })
    const subagent = observe(broker.hold({ ...request('permissionRequest_bashCorrelated'), agentId: subagentId }))
    const main = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse({ sessionId: pre.sessionId, toolUseId: 'toolu_main' })
    await flush()
    expect([main.done, subagent.done]).toEqual([true, false])
    broker.postToolUse({ sessionId: pre.sessionId, toolUseId: 'toolu_sub' })
    await flush()
    expect(subagent.done).toBe(true)
  })

  it('does not pair a request with the Pre of an earlier auto-allowed identical call', async () => {
    // Az első hívás engedély nélkül futott le (Pre, majd Post, PermissionRequest nélkül). Ha a Pre-je
    // a 60 mp-es sorban marad, a következő azonos hívás kérése az ő régi azonosítóját kapná.
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    const pre = toolUse('preToolUse_bash')
    broker.preToolUse({ ...pre, toolUseId: 'toolu_auto' })
    broker.postToolUse({ sessionId: pre.sessionId, toolUseId: 'toolu_auto' })
    clock.advance(10_000)

    broker.preToolUse({ ...pre, toolUseId: 'toolu_asked' })
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))
    broker.postToolUse({ sessionId: pre.sessionId, toolUseId: 'toolu_asked' })
    await flush()
    expect(held.done).toBe(true)
    expect(broker.views()).toEqual([])
  })

  it('answers a request that arrives after releaseAll at once, so shutdown cannot hang', async () => {
    const broker = new DecisionBroker(fakeClock())
    broker.releaseAll()
    const late = observe(broker.hold(request('permissionRequest_bash')))
    await flush()
    expect(late.done).toBe(true)
    expect(late.value).toBeUndefined()
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
