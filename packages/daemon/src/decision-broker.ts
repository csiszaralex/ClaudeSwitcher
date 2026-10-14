import { randomUUID } from 'node:crypto'
import {
  buildHookResponse,
  type HookDecisionBody,
  type PermissionRequestInfo,
  type UserDecision,
} from '@claudeswitcher/core'

/**
 * A PermissionRequest hook timeoutja 600 mp (apps/desktop/src/main/setup.ts). 10 mp-cel előtte
 * engedünk el, hogy a lezárást mindig mi kezdeményezzük, üres 200-zal. A natív prompt ettől nem
 * tűnik el, és utána is válaszolható (mérve: 2,5 perccel az elengedés után is).
 */
export const RELEASE_AFTER_MS = 590_000

/** Ennyi ideig vár egy PreToolUse arra, hogy megérkezzen a hozzá tartozó PermissionRequest. */
const PRE_TOOL_USE_TTL_MS = 60_000
/** Felső korlát a párosítatlan PreToolUse-okra, hogy egy sűrű session se szivárogjon. */
const PRE_TOOL_USE_CAP = 500

export interface PendingDecisionView extends PermissionRequestInfo {
  id: string
  createdAt: number
  /** Igaz, ha az app elengedte (590 mp): onnan már csak a VSCode-ban vagy a telefonon dönthető. */
  released: boolean
}

/** Egy tool-hívás a PreToolUse / PostToolUse hookból. */
export interface ToolUseEvent {
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
}

export type DecideResult = { ok: true } | { ok: false; reason: string }

/** Az idő és az időzítők. Tesztben hamisítható, hogy a 590 mp-et ne kelljen kivárni. */
export interface BrokerClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: BrokerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    // Egy tartott döntés ne tartsa életben a processzt kilépéskor.
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

interface Pending {
  view: PendingDecisionView
  key: string
  toolUseId: string | undefined
  timer: unknown
  respond: (body: HookDecisionBody | undefined) => void
}

/** Kulcssorrendtől független szerializálás, hogy a PreToolUse és a PermissionRequest bemenete egyezzen. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function callKey(sessionId: string, toolName: string, toolInput: Record<string, unknown>): string {
  return `${sessionId}\u0000${toolName}\u0000${stable(toolInput)}`
}

/**
 * A tartott PermissionRequest-ek tulajdonosa — a rendszer egyetlen valódi konkurens állapotgépe.
 *
 * Három forrásból jöhet döntés, és az első nyer: az app (`decide`), a VSCode vagy a telefon
 * (`postToolUse`, `sessionStopped`, `subagentStopped`), illetve az elengedés. Minden tartott
 * kérés pontosan egyszer kap választ: ezt a `respond` saját zára garantálja.
 */
export class DecisionBroker {
  readonly #clock: BrokerClock
  readonly #releaseAfterMs: number
  readonly #pending = new Map<string, Pending>()
  readonly #listeners: Array<() => void> = []
  #recentPre: Array<{ key: string; toolUseId: string; at: number }> = []

  constructor(clock: BrokerClock = systemClock, releaseAfterMs: number = RELEASE_AFTER_MS) {
    this.#clock = clock
    this.#releaseAfterMs = releaseAfterMs
  }

  onChange(listener: () => void): void {
    this.#listeners.push(listener)
  }

  /** A kérés tartása. A visszaadott ígéret a hook válaszával teljesül; `undefined` = nincs döntés. */
  hold(request: PermissionRequestInfo): Promise<HookDecisionBody | undefined> {
    const id = randomUUID()
    const key = callKey(request.sessionId, request.toolName, request.toolInput)
    const toolUseId = this.#takeRecentPre(key)

    return new Promise<HookDecisionBody | undefined>((resolve) => {
      let settled = false
      const pending: Pending = {
        view: { ...request, id, createdAt: this.#clock.now(), released: false },
        key,
        toolUseId,
        timer: undefined,
        respond: (body) => {
          if (settled) return
          settled = true
          resolve(body)
        },
      }
      pending.timer = this.#clock.setTimeout(() => {
        this.#release(id)
      }, this.#releaseAfterMs)
      this.#pending.set(id, pending)
      this.#emit()
    })
  }

  /** A felhasználó döntése az appból. Érvénytelen döntésnél a kérés függőben marad. */
  decide(id: string, decision: UserDecision): DecideResult {
    const pending = this.#pending.get(id)
    if (pending === undefined) return { ok: false, reason: 'Ez a kérés már lezárult.' }
    if (pending.view.released) {
      return { ok: false, reason: 'Az app már elengedte ezt a kérést — dönts a VSCode-ban.' }
    }
    const result = buildHookResponse(pending.view, decision)
    if (!result.ok) return result
    this.#finish(id, result.body)
    return { ok: true }
  }

  /** A PreToolUse hozza a `tool_use_id`-t, ami a PermissionRequest-ből hiányzik. */
  preToolUse(event: ToolUseEvent): void {
    const key = callKey(event.sessionId, event.toolName, event.toolInput)
    // Ha a PermissionRequest valamiért előbb ért ide, most kötjük hozzá.
    for (const pending of this.#pending.values()) {
      if (pending.key === key && pending.toolUseId === undefined) {
        pending.toolUseId = event.toolUseId
        return
      }
    }
    const now = this.#clock.now()
    this.#recentPre = this.#recentPre
      .filter((entry) => now - entry.at < PRE_TOOL_USE_TTL_MS)
      .slice(-(PRE_TOOL_USE_CAP - 1))
    this.#recentPre.push({ key, toolUseId: event.toolUseId, at: now })
  }

  /** A tool lefutott — a döntés tehát máshol (VSCode, telefon) már megszületett. */
  postToolUse(event: { sessionId: string; toolUseId: string }): void {
    this.#closeWhere((pending) => pending.toolUseId === event.toolUseId)
  }

  /** A session köre véget ért vagy a session leállt: nála már nincs függő döntés. */
  sessionStopped(sessionId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId)
  }

  /** Egy subagent leállt. A szülő session_id-ján fut, ezért az agent_id dönt. */
  subagentStopped(sessionId: string, agentId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId && pending.view.agentId === agentId)
  }

  /** Minden tartott kérés elengedése — a daemon leállásakor, a `server.close()` ELŐTT. */
  releaseAll(): void {
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timer)
      pending.respond(undefined)
    }
    this.#pending.clear()
    this.#emit()
  }

  views(): PendingDecisionView[] {
    return [...this.#pending.values()].map((pending) => pending.view).sort((a, b) => a.createdAt - b.createdAt)
  }

  #takeRecentPre(key: string): string | undefined {
    const now = this.#clock.now()
    for (let index = this.#recentPre.length - 1; index >= 0; index--) {
      const entry = this.#recentPre[index]
      if (entry === undefined) continue
      if (entry.key === key && now - entry.at < PRE_TOOL_USE_TTL_MS) {
        this.#recentPre.splice(index, 1)
        return entry.toolUseId
      }
    }
    return undefined
  }

  #release(id: string): void {
    const pending = this.#pending.get(id)
    if (pending === undefined || pending.view.released) return
    pending.respond(undefined)
    // A sor marad: a natív prompt is marad. Lezárni a PostToolUse vagy a Stop fogja.
    pending.view = { ...pending.view, released: true }
    this.#emit()
  }

  #finish(id: string, body: HookDecisionBody | undefined): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#clock.clearTimeout(pending.timer)
    pending.respond(body)
    this.#pending.delete(id)
    this.#emit()
  }

  #closeWhere(predicate: (pending: Pending) => boolean): void {
    for (const [id, pending] of [...this.#pending]) {
      if (predicate(pending)) this.#finish(id, undefined)
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[decisions] listener failed', error)
      }
    }
  }
}
