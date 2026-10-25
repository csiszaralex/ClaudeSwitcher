import { appendFile } from 'node:fs/promises'
import {
  parsePermissionRequest,
  type HookDecisionBody,
  type PermissionRequestInfo,
  type RateLimits,
  type RateLimitWindow,
} from '@claudeswitcher/core'
import { Hono } from 'hono'
import type { ToolUseEvent } from './decision-broker.js'

export interface NotificationEvent {
  sessionId: string
  cwd: string
  type: string
  text?: string | undefined
}

export interface LifecycleEvent {
  sessionId: string
  cwd: string
  kind: 'start' | 'end' | 'stop'
}

export interface HookEvents {
  onNotification(event: NotificationEvent): void | Promise<void>
  onLifecycle(event: LifecycleEvent): void | Promise<void>
  onRateLimits(limits: RateLimits): void | Promise<void>
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
 * megölné** — vagyis minden session hook-kezelését, nem csak ezt az egy hívást.
 * Szándékosan nem `await`-eljük: a válasz azonnal megy, a kezelő a maga
 * tempójában fut.
 */
function contain(result: void | Promise<void>, what: string): void {
  void Promise.resolve(result).catch((error: unknown) => {
    console.error(`[hook] ${what} handler failed`, error)
  })
}

const LIFECYCLE_KINDS = new Set(['start', 'end', 'stop'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function limitWindow(v: unknown): RateLimitWindow | undefined {
  if (!isRecord(v)) return undefined
  const usedPercentage = v['used_percentage']
  const resetsAt = v['resets_at']
  if (typeof usedPercentage !== 'number' || typeof resetsAt !== 'number') return undefined
  return { used_percentage: usedPercentage, resets_at: resetsAt }
}

function toolUseEvent(b: Record<string, unknown>): ToolUseEvent | undefined {
  const sessionId = str(b['session_id'])
  const toolName = str(b['tool_name'])
  const toolUseId = str(b['tool_use_id'])
  const toolInput = b['tool_input']
  if (sessionId === undefined || toolName === undefined || toolUseId === undefined || !isRecord(toolInput)) {
    return undefined
  }
  // Subagentnél ott van; a mezőnév a mért permissionRequest_subagent és subagentStop fixture-ökből.
  const agentId = str(b['agent_id'])
  return { sessionId, ...(agentId === undefined ? {} : { agentId }), toolName, toolInput, toolUseId }
}

/**
 * A daemon hook-szervere. A display-only route-ok feltétel nélkül 200-at adnak üres törzzsel: a
 * szerver hibája soha nem akaszthat meg egy sessiont. A PermissionRequest route a döntést tartja,
 * de bármilyen hiba esetén ott is üres 200 megy — mérve, hogy ezt a Claude Code „nincs döntés"-nek
 * veszi, nem tiltásnak.
 */
export function createHookApp(token: string, events: HookEvents, rawLogPath?: string): Hono {
  const app = new Hono()

  /**
   * Kiírja a NYERS hook-törzset, ha kértek naplót. Alapból kikapcsolva.
   *
   * Azért a nyers törzs, és nem a kiolvasott mezők: a hookok tényleges alakja nincs
   * dokumentálva, tehát épp a saját értelmezésünk a leggyanúsabb. Ha rossz mezőnevet
   * olvasunk, a feldolgozott adat ugyanúgy hiányos lesz — a nyers viszont megmutatja.
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

  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) {
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

  app.post('/hooks/notification', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/notification', b)
      const sessionId = str(b['session_id'])
      const type = str(b['notification_type'])
      if (sessionId !== undefined && type !== undefined) {
        contain(
          events.onNotification({
            sessionId,
            cwd: str(b['cwd']) ?? '',
            type,
            // A Claude Code `message`-ben küldi — a CLAUDESWITCHER_HOOK_LOG nyers naplójából
            // mérve. A `notification_text` csak tartalék, ha egy jövőbeli verzió átnevezné.
            text: str(b['message']) ?? str(b['notification_text']),
          }),
          'notification',
        )
      }
    } catch (error) {
      console.error('[hook] notification handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/hooks/lifecycle/:kind', async (c) => {
    try {
      const kind = c.req.param('kind')
      const b = await body(c)
      record(`/hooks/lifecycle/${kind}`, b)
      const sessionId = str(b['session_id'])
      if (sessionId !== undefined && LIFECYCLE_KINDS.has(kind)) {
        contain(
          events.onLifecycle({
            sessionId,
            cwd: str(b['cwd']) ?? '',
            kind: kind as LifecycleEvent['kind'],
          }),
          'lifecycle',
        )
      }
    } catch (error) {
      console.error('[hook] lifecycle handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/hooks/permission-request', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/permission-request', b)
      const request = parsePermissionRequest(b)
      if (request === undefined) return c.body(null, 200)
      // A @hono/node-server ezt a jelet bontja, ha a válasz befejezése előtt zárul a kapcsolat
      // (megszakítás a VSCode-ban, a session processzének halála) — valódi szerverrel tesztelve.
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

  app.post('/hooks/pre-tool-use', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/pre-tool-use', b)
      const event = toolUseEvent(b)
      if (event !== undefined) events.onPreToolUse(event)
    } catch (error) {
      console.error('[hook] pre-tool-use handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/hooks/post-tool-use', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/post-tool-use', b)
      const sessionId = str(b['session_id'])
      const toolUseId = str(b['tool_use_id'])
      if (sessionId !== undefined && toolUseId !== undefined) events.onPostToolUse({ sessionId, toolUseId })
    } catch (error) {
      console.error('[hook] post-tool-use handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/hooks/subagent-stop', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/subagent-stop', b)
      const sessionId = str(b['session_id'])
      const agentId = str(b['agent_id'])
      if (sessionId !== undefined && agentId !== undefined) events.onSubagentStop({ sessionId, agentId })
    } catch (error) {
      console.error('[hook] subagent-stop handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/statusline', async (c) => {
    try {
      const b = await body(c)
      record('/statusline', b)
      const raw = b['rate_limits']
      if (isRecord(raw)) {
        const limits: RateLimits = {}
        const five = limitWindow(raw['five_hour'])
        const seven = limitWindow(raw['seven_day'])
        const spend = limitWindow(raw['spend_limit'])
        if (five) limits.five_hour = five
        if (seven) limits.seven_day = seven
        if (spend) limits.spend_limit = spend
        if (Object.keys(limits).length > 0) {
          contain(events.onRateLimits(limits), 'statusline')
        }
      }
    } catch (error) {
      console.error('[hook] statusline handler failed', error)
    }
    return c.body(null, 200)
  })

  return app
}
