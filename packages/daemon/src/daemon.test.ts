import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { DAEMON_PROTOCOL } from '@claudeswitcher/core'
import { fakeProbe, hookPayload, tempDir, writeSessionRecord } from '@claudeswitcher/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { isToken, startDaemon, type Daemon } from './daemon.js'
import { waitFor } from './test-helpers.js'

const aliveProbe = fakeProbe()
let running: Daemon | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

async function fixture(): Promise<string> {
  const dir = await tempDir('cs-daemon-')
  await writeSessionRecord(dir)
  return dir
}

/**
 * Waits until every message the server has sent so far has arrived. The ws server answers a ping with
 * a pong (`autoPong`, on by default), and the frames on one socket arrive in order, so every earlier
 * message has arrived before the pong. The ping itself triggers no state message and does not skew
 * the count.
 */
async function drained(socket: WebSocket): Promise<void> {
  const pong = new Promise((resolve) => socket.once('pong', resolve))
  socket.ping()
  await pong
}

describe('startDaemon', () => {
  it('binds to loopback on an ephemeral port and exposes a token', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    expect(running.port).toBeGreaterThan(0)
    expect(isToken(running.token)).toBe(true)
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
    // The positive control. Without it the two rejection tests would also pass if the connection
    // failed for some reason unrelated to us.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${running.token}`)

    await new Promise((resolve) => socket.on('open', resolve))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  /**
   * From the client's side: to an unauthenticated request the server sends an HTTP response instead
   * of the 101, which the `ws` client reports as `unexpected-response`. There is no `open` then.
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
      // A close after a 101 also ends up here, so a rejection after the handshake (the old way) fails the test.
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
    // Two separate contracts, and the point is the two together. An identical SNAPSHOT is not sent
    // again: the poll runs every 3 seconds, which would be twenty identical messages a minute. But a
    // heartbeat goes out after EVERY scan, or the client could not tell "alive, no change" from "the
    // poll stopped".
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
    await drained(socket)
    socket.close()

    const types = messages.map((m) => (JSON.parse(m) as { type: string }).type)
    expect(types.filter((t) => t === 'state')).toHaveLength(0)
    expect(types.filter((t) => t === 'tick')).toHaveLength(2)
  })

  it('stamps every state and tick message with the protocol version', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${running.token}`)
    const messages: { type: string; protocol?: unknown }[] = []
    const gotTick = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data instanceof Buffer ? data.toString('utf8') : '') as { type: string }
        messages.push(message)
        if (message.type === 'tick') resolve()
      })
    })
    await new Promise((resolve) => socket.on('open', resolve))

    // The first scan changes the snapshot (state) and then sends a heartbeat (tick).
    await running.refresh()
    await gotTick
    socket.close()

    expect(messages.map((m) => m.type)).toEqual(['state', 'tick'])
    // The constant must exist too: with a missing export the two `undefined` values would match.
    expect(DAEMON_PROTOCOL).toEqual(expect.any(Number))
    for (const message of messages) expect(message.protocol).toBe(DAEMON_PROTOCOL)
  })

  it('uses the token it is given instead of generating one', async () => {
    const token = 'a'.repeat(32)
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0, token })
    expect(running.token).toBe(token)
  })

  it('binds the port it is given, and fails loudly when that port is taken', async () => {
    // The desktop app passes a fixed port so the installed hooks stay live after a restart. A port in
    // use is therefore a start-up ERROR, not a silent switch to another port: the switch is exactly
    // what would make the installed hooks dead.
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

function postHook(daemon: Daemon, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
    body: JSON.stringify(body),
  })
}

describe('startDaemon: held decisions', () => {
  it('holds a PermissionRequest until the user decides, then answers with the decision', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    const response = postHook(daemon, '/hooks/permission-request', hookPayload('permissionRequest_bash'))

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
    await postHook(daemon, '/hooks/pre-tool-use', hookPayload('preToolUse_bash'))
    const response = postHook(daemon, '/hooks/permission-request', hookPayload('permissionRequest_bashCorrelated'))
    await waitFor(() => daemon.state().decisions)

    await postHook(daemon, '/hooks/post-tool-use', hookPayload('postToolUse_bash'))
    const res = await response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(daemon.state().decisions).toEqual([])
  })

  it('marks the session waiting while its decision is held', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    // A measured payload, matched to the session of the fixture registry.
    void postHook(daemon, '/hooks/permission-request', { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' })

    await waitFor(() => daemon.state().decisions)
    expect(daemon.state().sessions[0]?.status).toBe('waiting')
  })

  it('clears the waiting row when the app decides, and ignores the late permission_prompt', async () => {
    // Measured live: after the decision the row stayed "waiting" until the Stop. For a decision within
    // 6 s the Notification arrives AFTER the decision, and that must not be taken as a new wait either.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const request = { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' }
    const prompt = { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' }
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
    // Between two separate updates the renderer would briefly see a session already decided but
    // still "waiting".
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    void postHook(daemon, '/hooks/permission-request', { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' })
    const [pending] = await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' })

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
    await drained(socket)
    socket.close()

    expect(states).toHaveLength(1)
    expect(states[0]?.decisions).toEqual([])
    expect(states[0]?.sessions[0]?.status).toBe('idle')
  })

  it('clears the waiting row when a tool of the session has run', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    await postHook(daemon, '/hooks/notification', { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('waiting')

    await postHook(daemon, '/hooks/post-tool-use', { ...hookPayload('postToolUse_bash'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('idle')
  })

  it('closes the row and clears the wait when a natively allowed tool fails (PostToolUseFailure)', async () => {
    // PostToolUseFailure comes to the PostToolUse route: the failing tool has run too, the decision was made.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    await postHook(daemon, '/hooks/pre-tool-use', { ...hookPayload('preToolUse_bash'), session_id: 'sid-100' })
    const response = postHook(daemon, '/hooks/permission-request', {
      ...hookPayload('permissionRequest_bashCorrelated'),
      session_id: 'sid-100',
    })
    await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('waiting')

    await postHook(daemon, '/hooks/post-tool-use', { ...hookPayload('postToolUseFailure_bash_constructed'), session_id: 'sid-100' })
    expect(await (await response).text()).toBe('')
    expect(daemon.state().decisions).toEqual([])
    expect(daemon.state().sessions[0]?.status).toBe('idle')
  })

  it('ends the main turn on StopFailure: the row closes, the wait clears, and the session just finished', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const response = postHook(daemon, '/hooks/permission-request', { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' })

    const before = Date.now()
    await postHook(daemon, '/hooks/lifecycle/stop', { ...hookPayload('stopFailure_rateLimit_constructed'), session_id: 'sid-100' })
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
    await postHook(daemon, '/hooks/lifecycle/stop', { ...hookPayload('stop'), session_id: 'sid-100' })
    const stoppedAt = daemon.state().sessions[0]?.stoppedAt
    expect(stoppedAt).toBeGreaterThanOrEqual(before)
    expect(daemon.state().sessions[0]?.status).toBe('idle')

    await postHook(daemon, '/hooks/pre-tool-use', { ...hookPayload('preToolUse_bash'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.stoppedAt).toBeUndefined()
  })

  it('keeps a background subagent\'s request held through the main Stop, and the session waiting', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const main = postHook(daemon, '/hooks/permission-request', { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' })
    void postHook(daemon, '/hooks/permission-request', { ...hookPayload('permissionRequest_subagent'), session_id: 'sid-100' })
    await waitFor(() => (daemon.state().decisions.length === 2 ? daemon.state().decisions : []))

    await postHook(daemon, '/hooks/lifecycle/stop', { ...hookPayload('stop'), session_id: 'sid-100' })
    expect(await (await main).text()).toBe('')
    expect(daemon.state().decisions.map((d) => d.agentId)).toEqual(['ad0b11acf46ef176e'])
    expect(daemon.state().sessions[0]?.status).toBe('waiting')

    await postHook(daemon, '/hooks/subagent-stop', { ...hookPayload('subagentStop'), session_id: 'sid-100' })
    expect(daemon.state().decisions).toEqual([])
    expect(daemon.state().sessions[0]?.status).toBe('idle')
  })

  it('keeps the label of a subagent that waits on a held decision longer than the staleness window', async () => {
    // Constructed subagent files in the measured layout (see core subagent.ts), not real content.
    const dir = await fixture()
    const agentId = String(hookPayload('permissionRequest_subagent')['agent_id'])
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

    void postHook(daemon, '/hooks/permission-request', { ...hookPayload('permissionRequest_subagent'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await daemon.refresh()
    expect(daemon.state().sessions[0]?.subagents?.map((s) => [s.agentId, s.description])).toEqual([
      [agentId, 'Teszt hullám'],
    ])
  })

  it('drops a held request when the hook client disconnects — over a real socket', async () => {
    // Cancelled in VS Code, or the session's process died: neither a Stop nor a PostToolUse comes, only
    // the connection closes. There is nobody to answer, and the row must not stay waiting for a decision.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    const client = new AbortController()
    const response = fetch(`http://127.0.0.1:${daemon.port}/hooks/permission-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify(hookPayload('permissionRequest_bash')),
      signal: client.signal,
    })
    await waitFor(() => daemon.state().decisions)

    client.abort()
    await expect(response).rejects.toThrow()
    await waitFor(() => (daemon.state().decisions.length === 0 ? [true] : []))
    expect(daemon.state().decisions).toEqual([])
  })

  /** A held request that the test closes from the client's side (a native No or Esc in VS Code). */
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
    // Measured (2026-10-25): after a native No or Esc no Stop, PostToolUse or Notification comes, only
    // the held connection closes. After about 6 s of waiting the permission_prompt has already set the
    // wait, and nothing else would clear it.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const held = abortableRequest(daemon, { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await postHook(daemon, '/hooks/notification', { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' })
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
    await drained(socket)
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
    const first = abortableRequest(daemon, { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    const second = abortableRequest(daemon, { ...hookPayload('permissionRequest_subagent'), session_id: 'sid-100' })
    await waitFor(() => (daemon.state().decisions.length === 2 ? [true] : []))
    await postHook(daemon, '/hooks/notification', { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' })

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
    // A native answer within 6 s sends no Notification, so one arriving later belongs to a new prompt.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    const held = abortableRequest(daemon, { ...hookPayload('permissionRequest_bash'), session_id: 'sid-100' })
    await waitFor(() => daemon.state().decisions)
    await held.abort()
    await waitFor(() => (daemon.state().decisions.length === 0 ? [true] : []))

    await postHook(daemon, '/hooks/notification', { ...hookPayload('notification_permissionPrompt'), session_id: 'sid-100' })
    expect(daemon.state().sessions[0]?.status).toBe('waiting')
  })

  it('answers held requests on stop instead of hanging the shutdown', async () => {
    // Because of the held connections server.close() would otherwise never return.
    const daemon = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const response = postHook(daemon, '/hooks/permission-request', hookPayload('permissionRequest_bash'))
    await waitFor(() => daemon.state().decisions)

    await daemon.stop()
    const res = await response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('stops without waiting for a connection that has not sent a request yet', async () => {
    // The Node fetch opens such a connection after an aborted held request. Without the fix stop()
    // would wait until the client closes it, and this client does not: the test would time out.
    const daemon = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const silent = connect(daemon.port, '127.0.0.1')
    const closed = new Promise((resolve) => silent.on('close', resolve))
    silent.on('error', () => undefined)
    await new Promise((resolve) => silent.on('connect', resolve))
    // A full request on ANOTHER connection: the server accepts the connections in the order they
    // arrive, so by the time of the answer it has accepted the silent one too.
    expect((await postHook(daemon, '/hooks/notification', hookPayload('notification_permissionPrompt'))).status).toBe(200)

    await daemon.stop()
    await closed
  })
})
