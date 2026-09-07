import type { RateLimits, RateLimitWindow } from '@claudeswitcher/core'
import { Hono } from 'hono'

export interface NotificationEvent {
  sessionId: string
  cwd: string
  type: string
  text?: string
}

export interface LifecycleEvent {
  sessionId: string
  cwd: string
  kind: 'start' | 'end' | 'stop'
}

export interface HookEvents {
  onNotification(event: NotificationEvent): void
  onLifecycle(event: LifecycleEvent): void
  onRateLimits(limits: RateLimits): void
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
  const { used_percentage, resets_at } = v
  if (typeof used_percentage !== 'number' || typeof resets_at !== 'number') return undefined
  return { used_percentage, resets_at }
}

/**
 * Az M1 hook-szervere. Minden route feltétel nélkül 200-at ad üres törzzsel:
 * ezek display-only hookok, és a szerver hibája soha nem akaszthat meg egy
 * sessiont. A hibát naplózzuk, nem terjesztjük.
 */
export function createHookApp(token: string, events: HookEvents): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) {
      return c.text('unauthorized', 401)
    }
    await next()
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
      const sessionId = str(b.session_id)
      const type = str(b.notification_type)
      if (sessionId !== undefined && type !== undefined) {
        events.onNotification({
          sessionId,
          cwd: str(b.cwd) ?? '',
          type,
          text: str(b.notification_text),
        })
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
      const sessionId = str(b.session_id)
      if (sessionId !== undefined && LIFECYCLE_KINDS.has(kind)) {
        events.onLifecycle({
          sessionId,
          cwd: str(b.cwd) ?? '',
          kind: kind as LifecycleEvent['kind'],
        })
      }
    } catch (error) {
      console.error('[hook] lifecycle handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/statusline', async (c) => {
    try {
      const b = await body(c)
      const raw = b.rate_limits
      if (isRecord(raw)) {
        const limits: RateLimits = {}
        const five = limitWindow(raw.five_hour)
        const seven = limitWindow(raw.seven_day)
        const spend = limitWindow(raw.spend_limit)
        if (five) limits.five_hour = five
        if (seven) limits.seven_day = seven
        if (spend) limits.spend_limit = spend
        if (Object.keys(limits).length > 0) events.onRateLimits(limits)
      }
    } catch (error) {
      console.error('[hook] statusline handler failed', error)
    }
    return c.body(null, 200)
  })

  return app
}
