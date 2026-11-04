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
   * A hook válasza: döntés, vagy `undefined` = nincs döntés (üres 200, a natív prompt marad).
   * A `signal` a hook-kliens kapcsolata: akkor bomlik, ha a kliens a válasz előtt bontja.
   */
  onPermissionRequest(request: PermissionRequestInfo, signal: AbortSignal): Promise<HookDecisionBody | undefined>
  onPreToolUse(event: ToolUseEvent): void
  onPostToolUse(event: { sessionId: string; toolUseId: string }): void
  onSubagentStop(event: { sessionId: string; agentId: string }): void
}

/**
 * Egy hook-kezelő hibája soha nem eshet ki a route-ból. A szinkron dobást a
 * hívást körülvevő try/catch fogja el; az aszinkron elutasítást ez.
 *
 * Ez nem elméleti: a kezelők `void | Promise<void>`-ot adhatnak vissza, és egy
 * elkapatlan elutasítás alapértelmezett Node beállításokkal **az egész daemont
 * megölné**, vagyis minden session hook-kezelését, nem csak ezt az egy hívást.
 * Szándékosan nem `await`-eljük: a válasz azonnal megy, a kezelő a maga
 * tempójában fut.
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
  // Subagentnél ott van; a mezőnév a mért permissionRequest_subagent és subagentStop fixture-ökből.
  const agentId = nonEmptyString(b['agent_id'])
  return { sessionId, ...(agentId === undefined ? {} : { agentId }), toolName, toolInput, toolUseId }
}

/**
 * A daemon hook-szervere. A display-only route-ok feltétel nélkül 200-at adnak üres törzzsel: a
 * szerver hibája soha nem akaszthat meg egy sessiont. A PermissionRequest route a döntést tartja,
 * de bármilyen hiba esetén ott is üres 200 megy. Mérve, hogy ezt a Claude Code „nincs döntés"-nek
 * veszi, nem tiltásnak.
 */
export function createHookApp(token: string, events: HookEvents, rawLogPath?: string): Hono {
  const app = new Hono()

  /**
   * Kiírja a NYERS hook-törzset, ha kértek naplót. Alapból kikapcsolva.
   *
   * Azért a nyers törzs, és nem a kiolvasott mezők: a hookok tényleges alakja nincs
   * dokumentálva, tehát épp a saját értelmezésünk a leggyanúsabb. Ha rossz mezőnevet
   * olvasunk, a feldolgozott adat ugyanúgy hiányos lesz, a nyers viszont megmutatja.
   *
   * Soha nem vár rá a válasz, és egy írási hiba sem látszik a hívón: egy diagnosztika
   * nem akaszthat meg egy sessiont.
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
        // A Claude Code `message`-ben küldi, a CLAUDESWITCHER_HOOK_LOG nyers naplójából
        // mérve. A `notification_text` csak tartalék, ha egy jövőbeli verzió átnevezné.
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
      // A @hono/node-server ezt a jelet bontja, ha a válasz befejezése előtt zárul a kapcsolat
      // (megszakítás a VSCode-ban, a session processzének halála), valódi szerverrel tesztelve.
      const decision = await events.onPermissionRequest(request, c.req.raw.signal)
      if (decision === undefined) return c.body(null, 200)
      return c.body(JSON.stringify(decision), 200, { 'content-type': 'application/json' })
    } catch (error) {
      // Bármilyen hiba itt „nincs döntés": a natív prompt a VSCode-ban és a telefonon amúgy is
      // ott van, és egy hibás hookot a Claude Code sem vesz tiltásnak (spike R3, R4).
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
