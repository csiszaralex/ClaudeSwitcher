import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { HOOK_CONTRACT, hookPath } from '@claudeswitcher/core'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { createHookApp, type HookEvents } from './hook-server.js'
import { tempDir, waitFor } from './test-helpers.js'

const TOKEN = 'test-token'

const fixtures = JSON.parse(
  readFileSync(new URL('../../core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function payload(name: string): unknown {
  const value = fixtures[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function events(): HookEvents {
  return {
    onNotification: vi.fn(),
    onLifecycle: vi.fn(),
    onPermissionRequest: vi.fn(() => Promise.resolve(undefined)),
    onPreToolUse: vi.fn(),
    onPostToolUse: vi.fn(),
    onSubagentStop: vi.fn(),
  }
}

function post(app: ReturnType<typeof createHookApp>, url: string, body: unknown, token = TOKEN) {
  return app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

describe('hook app auth', () => {
  it('rejects a missing token', async () => {
    const app = createHookApp(TOKEN, events())
    const res = await app.request('/hooks/notification', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const app = createHookApp(TOKEN, events())
    expect((await post(app, '/hooks/notification', {}, 'nope')).status).toBe(401)
  })

  it('rejects a token of the right length that differs, and accepts the right one', async () => {
    const app = createHookApp(TOKEN, events())
    expect((await post(app, '/hooks/notification', {}, 'test-tokem')).status).toBe(401)
    expect((await post(app, '/hooks/notification', {}, TOKEN)).status).toBe(200)
  })
})

describe('raw hook logging', () => {
  it('writes the untouched payload when a log path is given', async () => {
    // Azért kell, mert a hookok VALÓS alakja nincs dokumentálva: a mezőneveket csak
    // méréssel lehet megtudni. A saját értelmezésünk ilyenkor pont a hibaforrás, ezért a
    // nyers törzset írjuk ki, nem a kiolvasott mezőket.
    const dir = await tempDir('cs-hooklog-')
    const logFile = path.join(dir, 'hooks.jsonl')
    const app = createHookApp(TOKEN, events(), logFile)
    /** A log teljes (sorvéggel lezárt) sorai, ha már legalább `count` van belőlük. */
    const completeLines = async (count: number): Promise<string[]> => {
      const content = await readFile(logFile, 'utf8').catch(() => '')
      const lines = content.split('\n').slice(0, -1)
      return lines.length >= count ? lines : []
    }

    // Az írás tűz-és-felejts `appendFile`: a második kérés csak az első sor után megy, különben
    // a két párhuzamos írás sorrendje nem garantált.
    await post(app, '/hooks/notification', { session_id: 's1', notification_type: 'x', odd_field: 42 })
    await waitFor(() => completeLines(1))
    await post(app, '/hooks/lifecycle/stop', { session_id: 's1' })

    const lines = (await waitFor(() => completeLines(2))).map((l) => JSON.parse(l) as { route: string; body: Record<string, unknown> })
    expect(lines).toHaveLength(2)
    expect(lines[0]?.route).toBe('/hooks/notification')
    // A kulcs: egy olyan mező is megmarad, amiről a kódunk nem tud.
    expect(lines[0]?.body['odd_field']).toBe(42)
    expect(lines[1]?.route).toBe('/hooks/lifecycle/stop')
  })

  it('still answers 200 when the log file cannot be written', async () => {
    // A diagnosztika soha nem akaszthat meg egy sessiont.
    const app = createHookApp(TOKEN, events(), path.join(tmpdir(), 'no-such-dir-xyz', 'a.jsonl'))
    const res = await post(app, '/hooks/notification', { session_id: 's1', notification_type: 'x' })
    expect(res.status).toBe(200)
  })

  it('writes nothing when no log path is given', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, '/hooks/notification', { session_id: 's1', notification_type: 'x' })).status).toBe(200)
    expect(ev.onNotification).toHaveBeenCalled()
  })
})

describe('POST /hooks/notification', () => {
  it('reads the prompt text from `message`, the field Claude Code actually sends', async () => {
    // Mérve, a CLAUDESWITCHER_HOOK_LOG nyers naplójából, egy valódi VSCode-os sessionből.
    // A korábbi kód `notification_text`-et olvasott, ami nem létezik — a szöveg ezért
    // minden várakozásnál üres volt, és az pont úgy nézett ki, mint ha nem jönne szöveg.
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/notification', {
      session_id: '672b0e7c-b1a1-488e-aca0-b44c545e515b',
      transcript_path: 'C:\\x.jsonl',
      cwd: 'P:\\05_Scripts\\BSZ-Parser',
      prompt_id: 'cc77cf3d-310d-4a4b-9fa8-3638863009c8',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
      notification_type: 'permission_prompt',
    })
    expect(ev.onNotification).toHaveBeenCalledWith({
      sessionId: '672b0e7c-b1a1-488e-aca0-b44c545e515b',
      cwd: 'P:\\05_Scripts\\BSZ-Parser',
      type: 'permission_prompt',
      text: 'Claude needs your permission to use Bash',
    })
  })

  it('forwards a permission_prompt notification', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    const res = await post(app, '/hooks/notification', {
      session_id: 'sid-1',
      cwd: 'p:\\proj\\alpha',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      notification_text: 'Claude needs permission to run pnpm test',
    })
    expect(res.status).toBe(200)
    expect(ev.onNotification).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      cwd: 'p:\\proj\\alpha',
      type: 'permission_prompt',
      text: 'Claude needs permission to run pnpm test',
    })
  })

  it('always answers 200 with an empty body so it never blocks a session', async () => {
    const ev = events()
    ;(ev.onNotification as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('handler exploded')
    })
    const app = createHookApp(TOKEN, ev)
    const res = await post(app, '/hooks/notification', {
      session_id: 'sid-1', cwd: 'c', notification_type: 'idle_prompt',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('ignores a payload without a session_id', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, '/hooks/notification', { notification_type: 'x' })).status).toBe(200)
    expect(ev.onNotification).not.toHaveBeenCalled()
  })

  it('contains an async handler rejection instead of letting it escape', async () => {
    // A kezelők `void | Promise<void>`-ot adhatnak vissza. Egy elkapatlan
    // elutasítás alapértelmezett Node beállításokkal az egész daemont megölné.
    const ev = events()
    const boom = new Error('async boom')
    ;(ev.onNotification as ReturnType<typeof vi.fn>).mockRejectedValue(boom)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post(createHookApp(TOKEN, ev), '/hooks/notification', {
      session_id: 'sid-1',
      cwd: 'c',
      notification_type: 'idle_prompt',
    })
    expect(res.status).toBe(200)

    await new Promise((resolve) => setImmediate(resolve))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('notification'), boom)
    logged.mockRestore()
  })
})

describe('POST /hooks/lifecycle/:kind', () => {
  it('forwards end and stop', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    for (const kind of ['end', 'stop'] as const) {
      await post(app, `/hooks/lifecycle/${kind}`, { session_id: 'sid-1', cwd: 'c' })
      expect(ev.onLifecycle).toHaveBeenCalledWith({ sessionId: 'sid-1', cwd: 'c', kind })
    }
  })

  it('ignores an unknown lifecycle kind', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, '/hooks/lifecycle/bogus', { session_id: 's', cwd: 'c' })).status).toBe(200)
    expect(ev.onLifecycle).not.toHaveBeenCalled()
  })

  it('ignores the retired lifecycle/start: nothing installs it, only uninstall still recognises its path', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, hookPath('lifecycle/start'), { session_id: 's', cwd: 'c' })).status).toBe(200)
    expect(ev.onLifecycle).not.toHaveBeenCalled()
  })
})

describe('POST /statusline', () => {
  it('is gone with the retired rate-limit feature', async () => {
    expect((await post(createHookApp(TOKEN, events()), '/statusline', { rate_limits: {} })).status).toBe(404)
  })
})

describe('M2 decision routes — measured payloads', () => {
  const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } as const

  it('answers a PermissionRequest with the handler\'s decision', async () => {
    const ev = { ...events(), onPermissionRequest: vi.fn(() => Promise.resolve(ALLOW)) }
    const res = await post(createHookApp(TOKEN, ev), '/hooks/permission-request', payload('permissionRequest_bash'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(ALLOW)
    expect(ev.onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', kind: 'tool' }),
      expect.any(AbortSignal),
    )
  })

  it('answers an empty 200 when there is no decision', async () => {
    const res = await post(createHookApp(TOKEN, events()), '/hooks/permission-request', payload('permissionRequest_bash'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers an empty 200 when the handler fails — never a denial', async () => {
    // Mérve (R3, R4): egy hibás hookot a Claude Code „nincs döntés"-nek vesz, a natív prompt marad.
    const ev = { ...events(), onPermissionRequest: vi.fn(() => Promise.reject(new Error('boom'))) }
    const res = await post(createHookApp(TOKEN, ev), '/hooks/permission-request', payload('permissionRequest_bash'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers an empty 200 for an unusable body without calling the handler', async () => {
    const ev = events()
    const res = await post(createHookApp(TOKEN, ev), '/hooks/permission-request', { nonsense: true })
    expect(res.status).toBe(200)
    expect(ev.onPermissionRequest).not.toHaveBeenCalled()
  })

  it('forwards a PreToolUse with its tool_use_id', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/pre-tool-use', payload('preToolUse_bash'))
    expect(ev.onPreToolUse).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      toolName: 'Bash',
      toolInput: { command: 'echo spike-c2 > c3.txt', description: 'Write spike-c2 to c3.txt' },
      toolUseId: 'toolu_014XMiXFVTin7eyaeqBvxbLQ',
    })
  })

  it('forwards the agent_id of a subagent\'s PreToolUse', async () => {
    // A mezőnév a mért subagent-fixture-ökből (permissionRequest_subagent, subagentStop).
    const agentId = (payload('permissionRequest_subagent') as Record<string, unknown>)['agent_id']
    expect(agentId).toBe('ad0b11acf46ef176e')
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/pre-tool-use', { ...(payload('preToolUse_bash') as object), agent_id: agentId })
    expect(ev.onPreToolUse).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ad0b11acf46ef176e' }))
  })

  it('leaves agentId out of a main-agent PreToolUse', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/pre-tool-use', payload('preToolUse_bash'))
    const [event] = vi.mocked(ev.onPreToolUse).mock.calls[0] ?? []
    expect(event !== undefined && 'agentId' in event).toBe(false)
  })

  it('forwards a PostToolUse with the same tool_use_id', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/post-tool-use', payload('postToolUse_bash'))
    expect(ev.onPostToolUse).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      toolUseId: 'toolu_014XMiXFVTin7eyaeqBvxbLQ',
    })
  })

  it('forwards a PostToolUseFailure on the PostToolUse route like a finished tool', async () => {
    // A konstruált payload extra mezői (error, is_interrupt, duration_ms) nem számítanak.
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/post-tool-use', payload('postToolUseFailure_bash_constructed'))
    expect(ev.onPostToolUse).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      toolUseId: 'toolu_014XMiXFVTin7eyaeqBvxbLQ',
    })
  })

  it('forwards a StopFailure on the Stop route as the end of the main turn', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/lifecycle/stop', payload('stopFailure_rateLimit_constructed'))
    expect(ev.onLifecycle).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      cwd: 'P:\\08_Apps\\cs-spike',
      kind: 'stop',
    })
  })

  it('forwards a SubagentStop with its agent_id', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/subagent-stop', payload('subagentStop'))
    expect(ev.onSubagentStop).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      agentId: 'ad0b11acf46ef176e',
    })
  })

  it('aborts the handler signal when the real client drops the connection', async () => {
    // A @hono/node-server a `c.req.raw.signal`-t a válasz befejezése előtti `close`-ra bontja.
    // Valódi szerverrel és valódi megszakított fetch-csel mérve, nem az `app.request`-tel.
    let signalled: (signal: AbortSignal) => void = () => undefined
    const received = new Promise<AbortSignal>((resolve) => {
      signalled = resolve
    })
    const ev = {
      ...events(),
      onPermissionRequest: vi.fn((_request: unknown, signal: AbortSignal) => {
        signalled(signal)
        return new Promise<undefined>(() => undefined)
      }),
    }
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: createHookApp(TOKEN, ev).fetch, hostname: '127.0.0.1', port: 0 }, () => {
        resolve(s)
      })
    })
    try {
      const { port } = server.address() as AddressInfo
      const client = new AbortController()
      const response = fetch(`http://127.0.0.1:${String(port)}/hooks/permission-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(payload('permissionRequest_bash')),
        signal: client.signal,
      })
      const signal = await received
      expect(signal.aborted).toBe(false)
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        })
      })

      client.abort()
      await expect(response).rejects.toThrow()
      await aborted
      expect(signal.aborted).toBe(true)
    } finally {
      server.close()
    }
  })

  it('rejects the new routes without the token', async () => {
    const app = createHookApp(TOKEN, events())
    for (const route of ['/hooks/permission-request', '/hooks/pre-tool-use', '/hooks/post-tool-use', '/hooks/subagent-stop']) {
      expect((await post(app, route, {}, 'nope')).status).toBe(401)
    }
  })
})

describe('hook contract coverage', () => {
  it('has a handler for every installed hook path', async () => {
    // Minden mező, amit bármelyik route olvas: így a kezelő akkor is lefut, ha a route csak egy részét nézi.
    const body = {
      ...(payload('permissionRequest_bash') as Record<string, unknown>),
      notification_type: 'permission_prompt',
      tool_use_id: 'toolu_contract',
      agent_id: 'agent-contract',
    }
    for (const hook of HOOK_CONTRACT) {
      const ev = events()
      const app = createHookApp(TOKEN, ev)
      const res = await post(app, hookPath(hook.route), body)
      expect(res.status, hook.event).toBe(200)
      const calls = (Object.values(ev) as Mock[]).reduce((sum, handler) => sum + handler.mock.calls.length, 0)
      expect(calls, `${hook.event} -> ${hookPath(hook.route)}`).toBeGreaterThan(0)
    }
  })
})
