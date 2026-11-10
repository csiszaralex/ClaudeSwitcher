import { appendFile } from 'node:fs/promises'
import {
  hookPath,
  isLifecycleKind,
  isRecord,
  lifecyclePath,
  nonEmptyString,
  parsePermissionRequest,
  type HookDecisionBody,
  type HookRoute,
  type LifecycleKind,
  type PermissionRequestInfo,
} from '@claudeswitcher/core'
import { Hono } from 'hono'
import type { ToolUseEvent } from './decision-broker.js'
import { matchesSecret } from './token-compare.js'

export interface NotificationEvent {
  sessionId: string
  cwd: string
  type: string
  text?: string | undefined
}

export interface LifecycleEvent {
  sessionId: string
  cwd: string
  kind: LifecycleKind
}

export interface HookEvents {
  onNotification(event: NotificationEvent): void | Promise<void>
  onLifecycle(event: LifecycleEvent): void | Promise<void>
  /**
   * The hook's answer: a decision, or `undefined` = no decision (an empty 200, the native prompt stays).
   * The `signal` is the hook client's connection: it aborts when the client disconnects before the answer.
   */
  onPermissionRequest(request: PermissionRequestInfo, signal: AbortSignal): Promise<HookDecisionBody | undefined>
  onPreToolUse(event: ToolUseEvent): void
  onPostToolUse(event: { sessionId: string; toolUseId: string }): void
  onSubagentStop(event: { sessionId: string; agentId: string }): void
}

/**
 * A hook handler's error must never escape the route. A synchronous throw is caught by the try/catch
 * around the call; an asynchronous rejection by this.
 *
 * This is not theoretical: the handlers may return `void | Promise<void>`, and with the default Node
 * settings an unhandled rejection **would kill the whole daemon**, that is the hook handling of every
 * session, not only this one call. It is deliberately not awaited: the answer goes at once, and the
 * handler runs at its own pace.
 */
function contain(result: void | Promise<void>, what: string): void {
  void Promise.resolve(result).catch((error: unknown) => {
    console.error(`[hook] ${what} handler failed`, error)
  })
}

function toolUseEvent(b: Record<string, unknown>): ToolUseEvent | undefined {
  const sessionId = nonEmptyString(b['session_id'])
  const toolName = nonEmptyString(b['tool_name'])
  const toolUseId = nonEmptyString(b['tool_use_id'])
  const toolInput = b['tool_input']
  if (sessionId === undefined || toolName === undefined || toolUseId === undefined || !isRecord(toolInput)) {
    return undefined
  }
  // Present for a subagent; the field name comes from the measured permissionRequest_subagent and subagentStop fixtures.
  const agentId = nonEmptyString(b['agent_id'])
  return { sessionId, ...(agentId === undefined ? {} : { agentId }), toolName, toolInput, toolUseId }
}

/**
 * The daemon's hook server. The display-only routes answer 200 with an empty body unconditionally:
 * an error of the server must never block a session. The PermissionRequest route holds the decision,
 * but on any error it also sends an empty 200. Measured: Claude Code takes that as "no decision", not
 * as a denial.
 */
export function createHookApp(token: string, events: HookEvents, rawLogPath?: string): Hono {
  const app = new Hono()

  /**
   * Writes the RAW hook body when a log was requested. Off by default.
   *
   * The raw body, not the fields read from it: the real shape of the hooks is undocumented, so our
   * own parsing is the most suspect part. When a wrong field name is read, the parsed data is just as
   * incomplete, but the raw body shows it.
   *
   * The answer never waits for it, and a write error is not visible to the caller: a diagnostic must
   * not block a session.
   */
  function record(route: string, body: unknown): void {
    if (rawLogPath === undefined) return
    const line = `${JSON.stringify({ at: new Date().toISOString(), route, body })}\n`
    void appendFile(rawLogPath, line, 'utf8').catch((error: unknown) => {
      console.error('[hook] raw log write failed', error)
    })
  }

  const expectedAuthorization = `Bearer ${token}`
  app.use('*', async (c, next) => {
    if (!matchesSecret(c.req.header('authorization'), expectedAuthorization)) {
      return c.text('unauthorized', 401)
    }
    await next()
    return undefined
  })

  async function body(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
    try {
      const parsed = await c.req.json()
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * A display-only route: reads and records the body, hands it to `handle`, and answers an empty
   * 200 whatever happens. A throwing `handle` is logged under the route's name.
   */
  function displayRoute(route: HookRoute, handle: (b: Record<string, unknown>) => void): void {
    const path = hookPath(route)
    app.post(path, async (c) => {
      try {
        const b = await body(c)
        record(path, b)
        handle(b)
      } catch (error) {
        console.error(`[hook] ${route} handler failed`, error)
      }
      return c.body(null, 200)
    })
  }

  displayRoute('notification', (b) => {
    const sessionId = nonEmptyString(b['session_id'])
    const type = nonEmptyString(b['notification_type'])
    if (sessionId === undefined || type === undefined) return
    contain(
      events.onNotification({
        sessionId,
        cwd: nonEmptyString(b['cwd']) ?? '',
        type,
        // Claude Code sends it in `message`, measured from the raw CLAUDESWITCHER_HOOK_LOG log.
        // `notification_text` is only a fallback in case a future version renames it.
        text: nonEmptyString(b['message']) ?? nonEmptyString(b['notification_text']),
      }),
      'notification',
    )
  })

  // The contract's `lifecycle/*` routes share one route with a parameter (`isLifecycleKind`). The
  // `hook contract coverage` test checks that every contract path has a handler.
  app.post(lifecyclePath(':kind'), async (c) => {
    try {
      const kind = c.req.param('kind')
      const b = await body(c)
      record(lifecyclePath(kind), b)
      const sessionId = nonEmptyString(b['session_id'])
      if (sessionId !== undefined && isLifecycleKind(kind)) {
        contain(
          events.onLifecycle({
            sessionId,
            cwd: nonEmptyString(b['cwd']) ?? '',
            kind,
          }),
          'lifecycle',
        )
      }
    } catch (error) {
      console.error('[hook] lifecycle handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post(hookPath('permission-request'), async (c) => {
    try {
      const b = await body(c)
      record(hookPath('permission-request'), b)
      const request = parsePermissionRequest(b)
      if (request === undefined) return c.body(null, 200)
      // @hono/node-server aborts this signal when the connection closes before the answer is finished
      // (cancelled in VS Code, the session's process died), tested with a real server.
      const decision = await events.onPermissionRequest(request, c.req.raw.signal)
      if (decision === undefined) return c.body(null, 200)
      return c.body(JSON.stringify(decision), 200, { 'content-type': 'application/json' })
    } catch (error) {
      // Any error here is "no decision": the native prompt is there in VS Code and on the phone anyway,
      // and Claude Code does not take a failing hook as a denial either (spike results R3, R4).
      console.error('[hook] permission request failed', error)
      return c.body(null, 200)
    }
  })

  displayRoute('pre-tool-use', (b) => {
    const event = toolUseEvent(b)
    if (event !== undefined) events.onPreToolUse(event)
  })

  displayRoute('post-tool-use', (b) => {
    const sessionId = nonEmptyString(b['session_id'])
    const toolUseId = nonEmptyString(b['tool_use_id'])
    if (sessionId !== undefined && toolUseId !== undefined) events.onPostToolUse({ sessionId, toolUseId })
  })

  displayRoute('subagent-stop', (b) => {
    const sessionId = nonEmptyString(b['session_id'])
    const agentId = nonEmptyString(b['agent_id'])
    if (sessionId !== undefined && agentId !== undefined) events.onSubagentStop({ sessionId, agentId })
  })

  return app
}
