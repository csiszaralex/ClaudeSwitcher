import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProcessProbe } from '@claudeswitcher/core'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startDaemon, type Daemon } from './daemon.js'

const aliveProbe: ProcessProbe = {
  isAlive: () => true,
  imageName: () => 'Code',
  startedAtMs: () => undefined,
  refresh: () => Promise.resolve(),
}
let running: Daemon | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cs-daemon-'))
  await mkdir(path.join(dir, 'sessions'), { recursive: true })
  await writeFile(
    path.join(dir, 'sessions', '100.json'),
    JSON.stringify({
      pid: 100, sessionId: 'sid-100', cwd: 'p:\\proj\\alpha',
      startedAt: 1, procStart: 'ps-100', name: 'alpha-01',
    }),
  )
  return dir
}

describe('startDaemon', () => {
  it('binds to loopback on an ephemeral port and exposes a token', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    expect(running.port).toBeGreaterThan(0)
    expect(running.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('serves the scanned sessions', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    await running.refresh()
    expect(running.state().sessions.map((s) => s.sessionId)).toEqual(['sid-100'])
  })

  it('marks a session waiting when a notification hook posts', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    await running.refresh()

    const res = await fetch(`http://127.0.0.1:${running.port}/hooks/notification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${running.token}` },
      body: JSON.stringify({
        session_id: 'sid-100',
        cwd: 'p:\\proj\\alpha',
        notification_type: 'permission_prompt',
        notification_text: 'run pnpm test?',
      }),
    })
    expect(res.status).toBe(200)
    expect(running.state().sessions[0]!.status).toBe('waiting')
  })

  it('rejects an unauthenticated hook post', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const res = await fetch(`http://127.0.0.1:${running.port}/hooks/notification`, {
      method: 'POST', body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('accepts a websocket connection carrying the right token', async () => {
    // Pozitív kontroll. Enélkül a két elutasítós teszt akkor is átmenne, ha a
    // kapcsolat valami tőlünk független okból hiúsulna meg.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${running.token}`)

    await new Promise((resolve) => socket.on('open', resolve))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  /**
   * A kliens felől: hitelesítetlen kérésre a szerver a 101 helyett HTTP-választ ad, amit a `ws`
   * kliens `unexpected-response`-ként jelez. Nyitás (`open`) ilyenkor nincs.
   */
  async function upgradeRejection(url: string): Promise<{ status: number | undefined; opened: boolean }> {
    const socket = new WebSocket(url)
    let opened = false
    socket.on('open', () => {
      opened = true
    })
    const status = await new Promise<number | undefined>((resolve) => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode)
        response.resume()
      })
      // Egy 101 utáni bezárás is ide futna: így a régi, kézfogás utáni elutasítás bukó teszt.
      socket.on('close', () => {
        resolve(undefined)
      })
      socket.on('error', () => undefined)
    })
    socket.terminate()
    return { status, opened }
  }

  it('answers 401 to a websocket upgrade presenting the wrong token, before any handshake', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    expect(await upgradeRejection(`ws://127.0.0.1:${running.port}/ws?token=wrong`)).toEqual({
      status: 401,
      opened: false,
    })
  })

  it('answers 401 to a websocket upgrade presenting no token, or a token of the right length', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    expect(await upgradeRejection(`ws://127.0.0.1:${running.port}/ws`)).toEqual({ status: 401, opened: false })
    const sameLength = running.token.replace(/^./, (c) => (c === '0' ? '1' : '0'))
    expect(await upgradeRejection(`ws://127.0.0.1:${running.port}/ws?token=${sameLength}`)).toEqual({
      status: 401,
      opened: false,
    })
  })

  it('does not re-broadcast an unchanged state, but does report every scan', async () => {
    // Két külön szerződés, és a kettő együtt a lényeg. Azonos PILLANATKÉPET nem küldünk
    // újra — a poll másodpercenként fut, az hússzor annyi azonos üzenet lenne percenként.
    // Viszont MINDEN szkennelés után megy egy életjel, különben a kliens nem tudná
    // megkülönböztetni azt, hogy „élünk, nincs változás", attól, hogy „megállt a poll".
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    await running.refresh()

    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${running.token}`)
    const messages: string[] = []
    socket.on('message', (data) => {
      messages.push(data instanceof Buffer ? data.toString('utf8') : '')
    })
    await new Promise((resolve) => socket.on('open', resolve))

    await running.refresh()
    await running.refresh()
    await new Promise((resolve) => setTimeout(resolve, 50))
    socket.close()

    const types = messages.map((m) => (JSON.parse(m) as { type: string }).type)
    expect(types.filter((t) => t === 'state')).toHaveLength(0)
    expect(types.filter((t) => t === 'tick')).toHaveLength(2)
  })

  it('stores rate limits posted by the status line', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    await fetch(`http://127.0.0.1:${running.port}/statusline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${running.token}` },
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: resetsAt } } }),
    })
    expect(running.state().rateLimits.five_hour?.used_percentage).toBe(23.5)
  })

  it('uses the token it is given instead of generating one', async () => {
    const token = 'a'.repeat(32)
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0, token })
    expect(running.token).toBe(token)
  })

  it('binds the port it is given, and fails loudly when that port is taken', async () => {
    // A desktop fix portot ad, hogy a telepített hookok az újraindítás után is élők
    // maradjanak. Egy foglalt port ezért indulási HIBA, nem csendes átállás egy másik
    // portra — az átállás pont a telepített hookokat tenné halottá.
    const first = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    try {
      await expect(
        startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0, port: first.port }),
      ).rejects.toThrow(/EADDRINUSE/)
    } finally {
      await first.stop()
    }
  })
})

const payloads = JSON.parse(
  readFileSync(new URL('../../core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>

function payload(name: string): Record<string, unknown> {
  const value = payloads[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function postHook(daemon: Daemon, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
    body: JSON.stringify(body),
  })
}

async function waitFor<T>(read: () => T[], timeoutMs = 2000): Promise<T[]> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value.length > 0) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('startDaemon — held decisions', () => {
  it('holds a PermissionRequest until the user decides, then answers with the decision', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    const response = postHook(daemon, '/hooks/permission-request', payload('permissionRequest_bash'))

    const [pending] = await waitFor(() => daemon.state().decisions)
    expect(daemon.decide(pending!.id, { type: 'allow' })).toEqual({ ok: true })
    const res = await response
    expect(await res.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(daemon.state().decisions).toEqual([])
  })

  it('closes a held request with an empty 200 when VS Code answers first', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await postHook(daemon, '/hooks/pre-tool-use', payload('preToolUse_bash'))
    const response = postHook(daemon, '/hooks/permission-request', payload('permissionRequest_bashCorrelated'))
    await waitFor(() => daemon.state().decisions)

    await postHook(daemon, '/hooks/post-tool-use', payload('postToolUse_bash'))
    const res = await response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(daemon.state().decisions).toEqual([])
  })

  it('marks the session waiting while its decision is held', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    // Valódi payload, a fixture-registry sessionjéhez igazítva.
    void postHook(daemon, '/hooks/permission-request', { ...payload('permissionRequest_bash'), session_id: 'sid-100' })

    await waitFor(() => daemon.state().decisions)
    expect(daemon.state().sessions[0]?.status).toBe('waiting')
  })

  it('clears the waiting row when the app decides, and ignores the late permission_prompt', async () => {
    // Mérve (Task 10 A, F): a döntés után a sor a Stop-ig „waiting" maradt. A 6 mp-en belüli
    // döntésnél a Notification a döntés UTÁN érkezik — azt sem szabad újra várakozásnak venni.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const request = { ...payload('permissionRequest_bash'), session_id: 'sid-100' }
    const prompt = { ...payload('notification_permissionPrompt'), session_id: 'sid-100' }
    const response = postHook(daemon, '/hooks/permission-request', request)
    const [pending] = await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', prompt)
    expect(daemon.state().sessions[0]?.notificationText).toBe('Claude needs your permission to use Write')

    expect(daemon.decide(pending!.id, { type: 'allow' })).toEqual({ ok: true })
    await response
    expect(daemon.state().sessions[0]?.status).toBe('idle')
    expect(daemon.state().sessions[0]?.notificationText).toBeUndefined()

    await postHook(daemon, '/hooks/notification', prompt)
    expect(daemon.state().sessions[0]?.status).toBe('idle')
  })

  it('broadcasts the decided session as no longer waiting in a single state message', async () => {
    // Két külön frissítés között a renderer egy pillanatra egy már eldöntött, de még
    // „waiting" sessiont látna.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    void postHook(daemon, '/hooks/permission-request', { ...payload('permissionRequest_bash'), session_id: 'sid-100' })
    const [pending] = await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...payload('notification_permissionPrompt'), session_id: 'sid-100' })

    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws?token=${daemon.token}`)
    const states: Array<{ sessions: Array<{ status: string }>; decisions: unknown[] }> = []
    socket.on('message', (data) => {
      const message = JSON.parse(data instanceof Buffer ? data.toString('utf8') : '{}') as {
        type: string
        payload: (typeof states)[number]
      }
      if (message.type === 'state') states.push(message.payload)
    })
    await new Promise((resolve) => socket.on('open', resolve))

    daemon.decide(pending!.id, { type: 'allow' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    socket.close()

    expect(states).toHaveLength(1)
    expect(states[0]?.decisions).toEqual([])
    expect(states[0]?.sessions[0]?.status).toBe('idle')
  })

  it('clears the waiting row when a tool of the session has run', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    await postHook(daemon, '/hooks/notification', { ...payload('notification_permissionPrompt'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('waiting')

    await postHook(daemon, '/hooks/post-tool-use', { ...payload('postToolUse_bash'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('idle')
  })

  it('closes the row and clears the wait when a natively allowed tool fails (PostToolUseFailure)', async () => {
    // A PostToolUseFailure a PostToolUse route-jára jön: a hibás tool is lefutott, a döntés megvolt.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    await postHook(daemon, '/hooks/pre-tool-use', { ...payload('preToolUse_bash'), session_id: 'sid-100' })
    const response = postHook(daemon, '/hooks/permission-request', {
      ...payload('permissionRequest_bashCorrelated'),
      session_id: 'sid-100',
    })
    await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...payload('notification_permissionPrompt'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('waiting')

    await postHook(daemon, '/hooks/post-tool-use', { ...payload('postToolUseFailure_bash_constructed'), session_id: 'sid-100' })
    expect(await (await response).text()).toBe('')
    expect(daemon.state().decisions).toEqual([])
    expect(daemon.state().sessions[0]?.status).toBe('idle')
  })

  it('ends the main turn on StopFailure: the row closes, the wait clears, and the session just finished', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const response = postHook(daemon, '/hooks/permission-request', { ...payload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...payload('notification_permissionPrompt'), session_id: 'sid-100' })

    const before = Date.now()
    await postHook(daemon, '/hooks/lifecycle/stop', { ...payload('stopFailure_rateLimit_constructed'), session_id: 'sid-100' })
    expect(await (await response).text()).toBe('')
    expect(daemon.state().decisions).toEqual([])
    expect(daemon.state().sessions[0]?.status).toBe('idle')
    expect(daemon.state().sessions[0]?.stoppedAt).toBeGreaterThanOrEqual(before)
  })

  it('reports when the session stopped, until a tool starts again', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const before = Date.now()
    await postHook(daemon, '/hooks/lifecycle/stop', { ...payload('stop'), session_id: 'sid-100' })
    const stoppedAt = daemon.state().sessions[0]?.stoppedAt
    expect(stoppedAt).toBeGreaterThanOrEqual(before)
    expect(daemon.state().sessions[0]?.status).toBe('idle')

    await postHook(daemon, '/hooks/pre-tool-use', { ...payload('preToolUse_bash'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.stoppedAt).toBeUndefined()
  })

  it('keeps a background subagent\'s request held through the main Stop, and the session waiting', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const main = postHook(daemon, '/hooks/permission-request', { ...payload('permissionRequest_bash'), session_id: 'sid-100' })
    void postHook(daemon, '/hooks/permission-request', { ...payload('permissionRequest_subagent'), session_id: 'sid-100' })
    await waitFor(() => (daemon.state().decisions.length === 2 ? daemon.state().decisions : []))

    await postHook(daemon, '/hooks/lifecycle/stop', { ...payload('stop'), session_id: 'sid-100' })
    expect(await (await main).text()).toBe('')
    expect(daemon.state().decisions.map((d) => d.agentId)).toEqual(['ad0b11acf46ef176e'])
    expect(daemon.state().sessions[0]?.status).toBe('waiting')

    await postHook(daemon, '/hooks/subagent-stop', { ...payload('subagentStop'), session_id: 'sid-100' })
    expect(daemon.state().decisions).toEqual([])
    expect(daemon.state().sessions[0]?.status).toBe('idle')
  })

  it('keeps the label of a subagent that waits on a held decision longer than the staleness window', async () => {
    // Konstruált subagent-fájlok a mért elrendezésben (lásd core subagent.ts), nem valódi tartalom.
    const dir = await fixture()
    const agentId = String(payload('permissionRequest_subagent')['agent_id'])
    const project = path.join(dir, 'projects', 'encoded-alpha')
    const subagents = path.join(project, 'sid-100', 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(path.join(project, 'sid-100.jsonl'), '')
    const transcript = path.join(subagents, `agent-${agentId}.jsonl`)
    await writeFile(transcript, `${JSON.stringify({ type: 'api-request', agentId, isSidechain: true })}\n`)
    await writeFile(
      path.join(subagents, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', description: 'Teszt hullám' }),
    )
    const silentSince = (Date.now() - 10 * 60_000) / 1000
    await utimes(transcript, silentSince, silentSince)

    running = await startDaemon({ claudeDir: dir, probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    expect(daemon.state().sessions[0]?.subagents).toBeUndefined()

    void postHook(daemon, '/hooks/permission-request', { ...payload('permissionRequest_subagent'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await daemon.refresh()
    expect(daemon.state().sessions[0]?.subagents?.map((s) => [s.agentId, s.description])).toEqual([
      [agentId, 'Teszt hullám'],
    ])
  })

  it('drops a held request when the hook client disconnects — over a real socket', async () => {
    // Megszakítás a VSCode-ban vagy a session processzének halála: nem jön se Stop, se PostToolUse,
    // csak a kapcsolat bomlik. Nincs kinek válaszolni, a sor ne maradjon döntésre váró.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    const client = new AbortController()
    const response = fetch(`http://127.0.0.1:${daemon.port}/hooks/permission-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify(payload('permissionRequest_bash')),
      signal: client.signal,
    })
    await waitFor(() => daemon.state().decisions)

    client.abort()
    await expect(response).rejects.toThrow()
    await waitFor(() => (daemon.state().decisions.length === 0 ? [true] : []))
    expect(daemon.state().decisions).toEqual([])
  })

  /** Egy tartott kérés, amit a teszt a kliens oldaláról bont (natív Nem vagy Esc a VSCode-ban). */
  function abortableRequest(daemon: Daemon, body: unknown): { abort: () => Promise<void> } {
    const client = new AbortController()
    const response = fetch(`http://127.0.0.1:${daemon.port}/hooks/permission-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify(body),
      signal: client.signal,
    })
    return {
      abort: async () => {
        client.abort()
        await response.catch(() => undefined)
      },
    }
  }

  it('clears the waiting row in a single state message when the native prompt is answered after the Notification', async () => {
    // Mérve (2026-10-25): natív Nem vagy Esc után nem jön Stop, PostToolUse vagy Notification,
    // csak a tartott kapcsolat bomlik. ~6 mp várakozás után a permission_prompt már beállította
    // a várakozást, és azt semmi más nem törölné.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const held = abortableRequest(daemon, { ...payload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...payload('notification_permissionPrompt'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.notificationText).toBe('Claude needs your permission to use Write')

    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws?token=${daemon.token}`)
    const states: Array<{ sessions: Array<{ status: string }>; decisions: unknown[] }> = []
    socket.on('message', (data) => {
      const message = JSON.parse(data instanceof Buffer ? data.toString('utf8') : '{}') as {
        type: string
        payload: (typeof states)[number]
      }
      if (message.type === 'state') states.push(message.payload)
    })
    await new Promise((resolve) => socket.on('open', resolve))

    await held.abort()
    await waitFor(() => (daemon.state().decisions.length === 0 ? [true] : []))
    await new Promise((resolve) => setTimeout(resolve, 50))
    socket.close()

    expect(daemon.state().sessions[0]?.status).toBe('idle')
    expect(daemon.state().sessions[0]?.notificationText).toBeUndefined()
    expect(states).toHaveLength(1)
    expect(states[0]?.decisions).toEqual([])
    expect(states[0]?.sessions[0]?.status).toBe('idle')
  })

  it('keeps the Notification-wait while another request of the session is still held, and clears it with the last one', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const first = abortableRequest(daemon, { ...payload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    const second = abortableRequest(daemon, { ...payload('permissionRequest_subagent'), session_id: 'sid-100' })
    await waitFor(() => (daemon.state().decisions.length === 2 ? [true] : []))
    await postHook(daemon, '/hooks/notification', { ...payload('notification_permissionPrompt'), session_id: 'sid-100' })

    await first.abort()
    await waitFor(() => (daemon.state().decisions.length === 1 ? [true] : []))
    expect(daemon.state().sessions[0]?.status).toBe('waiting')
    expect(daemon.state().sessions[0]?.notificationText).toBe('Claude needs your permission to use Write')

    await second.abort()
    await waitFor(() => (daemon.state().decisions.length === 0 ? [true] : []))
    expect(daemon.state().sessions[0]?.status).toBe('idle')
    expect(daemon.state().sessions[0]?.notificationText).toBeUndefined()
  })

  it('takes a permission_prompt after a native answer as a real wait, unlike after an app decision', async () => {
    // Natív válasz 6 mp-en belül nem küld Notificationt; egy később érkező így egy új prompté.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const held = abortableRequest(daemon, { ...payload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await held.abort()
    await waitFor(() => (daemon.state().decisions.length === 0 ? [true] : []))

    await postHook(daemon, '/hooks/notification', { ...payload('notification_permissionPrompt'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('waiting')
  })

  it('answers held requests on stop instead of hanging the shutdown', async () => {
    // A tartott kapcsolatok miatt a server.close() különben soha nem térne vissza.
    const daemon = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const response = postHook(daemon, '/hooks/permission-request', payload('permissionRequest_bash'))
    await waitFor(() => daemon.state().decisions)

    await daemon.stop()
    const res = await response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
