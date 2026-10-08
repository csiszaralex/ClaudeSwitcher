import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHookApp, type HookEvents } from './hook-server.js'

const TOKEN = 'test-token'

function events(): HookEvents {
  return { onNotification: vi.fn(), onLifecycle: vi.fn(), onRateLimits: vi.fn() }
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
})

describe('raw hook logging', () => {
  it('writes the untouched payload when a log path is given', async () => {
    // Azért kell, mert a hookok VALÓS alakja nincs dokumentálva: a mezőneveket csak
    // méréssel lehet megtudni. A saját értelmezésünk ilyenkor pont a hibaforrás, ezért a
    // nyers törzset írjuk ki, nem a kiolvasott mezőket.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-hooklog-'))
    const logFile = path.join(dir, 'hooks.jsonl')
    const app = createHookApp(TOKEN, events(), logFile)

    await post(app, '/hooks/notification', { session_id: 's1', notification_type: 'x', odd_field: 42 })
    await post(app, '/hooks/lifecycle/stop', { session_id: 's1' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0].route).toBe('/hooks/notification')
    // A kulcs: egy olyan mező is megmarad, amiről a kódunk nem tud.
    expect(lines[0].body.odd_field).toBe(42)
    expect(lines[1].route).toBe('/hooks/lifecycle/stop')
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
  it('forwards start, end and stop', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    for (const kind of ['start', 'end', 'stop'] as const) {
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
})

describe('POST /statusline', () => {
  it('forwards rate limits', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    await post(app, '/statusline', {
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    })
    expect(ev.onRateLimits).toHaveBeenCalledWith({
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    })
  })

  it('ignores a payload with no rate_limits (free plans, pre-first-response)', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, '/statusline', { model: { id: 'opus' } })).status).toBe(200)
    expect(ev.onRateLimits).not.toHaveBeenCalled()
  })

  it('ignores rate_limits whose windows are all unusable', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    await post(app, '/statusline', {
      rate_limits: { five_hour: { used_percentage: 'lots' }, seven_day: null },
    })
    expect(ev.onRateLimits).not.toHaveBeenCalled()
  })
})
