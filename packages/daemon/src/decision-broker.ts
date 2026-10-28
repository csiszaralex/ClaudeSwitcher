import { randomUUID } from 'node:crypto'
import {
  PERMISSION_RELEASE_AFTER_MS,
  POLL_INTERVAL_MS,
  buildHookResponse,
  type HookDecisionBody,
  type PermissionRequestInfo,
  type UserDecision,
} from '@claudeswitcher/core'

/**
 * Egy ELENGEDETT kérés ennyi ideig marad meg azután, hogy a sessionje kiesett a registry
 * pillanatképéből: tíz poll-kör (`POLL_INTERVAL_MS`), így egy kimaradt vagy félig írt registry-fájl nem
 * zár le egy élő sessiont. Ha a session processze meghalt, SessionEnd nem jön — e nélkül a sor
 * örökre megmaradna. A még dönthető kérést ez SOHA nem zárja (spec §8: a jóváhagyás felderítés
 * nélkül is működik); azt a hook-kliens bontása zárja, ami a processz halálával együtt jár.
 */
export const ABSENT_SESSION_GRACE_MS = 10 * POLL_INTERVAL_MS

/** Ennyi ideig vár egy PreToolUse arra, hogy megérkezzen a hozzá tartozó PermissionRequest. */
const PRE_TOOL_USE_TTL_MS = 60_000
/** Felső korlát a párosítatlan PreToolUse-okra, hogy egy sűrű session se szivárogjon. */
const PRE_TOOL_USE_CAP = 500

export interface PendingDecisionView extends PermissionRequestInfo {
  id: string
  createdAt: number
  /** Igaz, ha az app elengedte (`PERMISSION_RELEASE_AFTER_MS` után): onnan már csak a VSCode-ban vagy a telefonon dönthető. */
  released: boolean
}

/** Egy tool-hívás a PreToolUse / PostToolUse hookból. */
export interface ToolUseEvent {
  sessionId: string
  /** A subagent `agent_id`-ja; a fő agent hívásánál nincs. A subagent a szülő session_id-jával jön. */
  agentId?: string | undefined
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
}

export type DecideResult = { ok: true } | { ok: false; reason: string }

/** Egy változás oka, amit a figyelők a puszta „történt valami"-n túl megkapnak. */
export interface DecisionChange {
  /**
   * A session, amelynek egy kérését ez a változás azért zárta le, mert a hook-kliens bontotta a
   * kapcsolatot (natív Nem vagy Esc a VSCode-ban, vagy a session processzének halála). Minden más
   * változásnál `undefined`.
   */
  readonly abortedSessionId: string | undefined
}

const NO_ABORT: DecisionChange = { abortedSessionId: undefined }

/** Az idő és az időzítők. Tesztben hamisítható, hogy az elengedési időt ne kelljen kivárni. */
export interface BrokerClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: BrokerClock = {
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
  /** Mióta hiányzik a sessionje a registry pillanatképéből; `undefined`, ha ott van. */
  absentSince: number | undefined
  /** A kliens-bontás figyelőjének levétele. Lezáráskor és elengedéskor fut. */
  detach: () => void
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

/**
 * A Pre és a PermissionRequest párosításának kulcsa. Az `agentId` azért van benne, mert egy subagent
 * a szülő session_id-jával kér: nélküle a fő agent és egy subagent azonos parallel hívása egymás
 * azonosítóját vihetné el.
 */
function callKey(
  sessionId: string,
  agentId: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  return `${sessionId}\u0000${agentId ?? ''}\u0000${toolName}\u0000${stable(toolInput)}`
}

/**
 * A tartott PermissionRequest-ek tulajdonosa — a rendszer egyetlen valódi konkurens állapotgépe.
 *
 * Három forrásból jöhet döntés, és az első nyer: az app (`decide`), a VSCode vagy a telefon
 * (`postToolUse`, `sessionStopped`, `sessionEnded`, `subagentStopped`), illetve az elengedés.
 * Válasz nélkül zár a hook-kliens bontása és az eltűnt session elengedett kérésének takarítása
 * (`pruneAbsent`). Minden tartott kérés pontosan egyszer kap választ: ezt a `respond` saját
 * zára garantálja, akármelyik út ér oda elsőnek.
 */
export class DecisionBroker {
  readonly #clock: BrokerClock
  readonly #releaseAfterMs: number
  readonly #pending = new Map<string, Pending>()
  readonly #listeners: Array<(change: DecisionChange) => void> = []
  #recentPre: Array<{ key: string; toolUseId: string; at: number }> = []
  /** A `releaseAll` után igaz: a daemon leáll, új kérést már nem tartunk. */
  #closed = false

  constructor(clock: BrokerClock = systemClock, releaseAfterMs: number = PERMISSION_RELEASE_AFTER_MS) {
    this.#clock = clock
    this.#releaseAfterMs = releaseAfterMs
  }

  onChange(listener: (change: DecisionChange) => void): void {
    this.#listeners.push(listener)
  }

  /**
   * A kérés tartása. A visszaadott ígéret a hook válaszával teljesül; `undefined` = nincs döntés.
   *
   * @param signal — a hook-kliens kapcsolata. Ha bomlik (megszakítás a VSCode-ban, a session
   * processzének halála), nincs kinek válaszolni: a kérés válasz nélkül lezárul, és eltűnik a sorból.
   */
  hold(request: PermissionRequestInfo, signal?: AbortSignal): Promise<HookDecisionBody | undefined> {
    // Leállás után (releaseAll) semmit nem tartunk: egy ilyenkor érkező kérés különben a
    // server.close()-t az elengedésig feltartaná. Az üres 200 „nincs döntés", a natív prompt marad.
    if (this.#closed || signal?.aborted === true) return Promise.resolve(undefined)

    const id = randomUUID()
    const key = callKey(request.sessionId, request.agentId, request.toolName, request.toolInput)
    const toolUseId = this.#takeRecentPre(key)

    return new Promise<HookDecisionBody | undefined>((resolve) => {
      let settled = false
      const onAbort = (): void => {
        this.#finish(id, undefined, { abortedSessionId: request.sessionId })
      }
      const pending: Pending = {
        view: { ...request, id, createdAt: this.#clock.now(), released: false },
        key,
        toolUseId,
        timer: undefined,
        absentSince: undefined,
        detach: () => {
          signal?.removeEventListener('abort', onAbort)
        },
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
      signal?.addEventListener('abort', onAbort, { once: true })
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
    const key = callKey(event.sessionId, event.agentId, event.toolName, event.toolInput)
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

  /**
   * A tool lefutott (sikerrel vagy hibával), a döntés tehát máshol (VSCode, telefon) már megszületett.
   *
   * A hívás Pre-je is kikerül a sorból, ha még ott van: egy engedély nélkül lefutott hívásé ott
   * maradna 60 mp-ig, és egy azonos, de már engedélyt kérő hívás a régi azonosítót kapná.
   */
  postToolUse(event: { sessionId: string; toolUseId: string }): void {
    this.#recentPre = this.#recentPre.filter((entry) => entry.toolUseId !== event.toolUseId)
    this.#closeWhere((pending) => pending.toolUseId === event.toolUseId)
  }

  /**
   * A session fő köre véget ért (Stop): a FŐ agent kérései már nem függnek. A subagentéi igen: egy
   * `run_in_background` subagent a Stop után is fut, és a szülő session_id-jával kér. Azokat a
   * SubagentStop, a PostToolUse, a kliens bontása vagy a SessionEnd zárja.
   */
  sessionStopped(sessionId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId && pending.view.agentId === undefined)
  }

  /** A session véget ért (SessionEnd): a subagentjeivel együtt nála már semmi nem függ. */
  sessionEnded(sessionId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId)
  }

  /** Egy subagent leállt. A szülő session_id-ján fut, ezért az agent_id dönt. */
  subagentStopped(sessionId: string, agentId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId && pending.view.agentId === agentId)
  }

  /**
   * A registry friss pillanatképe után: az ELENGEDETT kéréseket, amelyek sessionje a türelmi
   * időnél régebben hiányzik, lezárja (lásd ABSENT_SESSION_GRACE_MS). A hiány kezdetét minden
   * kérésnél követi, így egy épp most elengedett kérés is azonnal lezárul, ha a sessionje már rég
   * eltűnt. Csak sikeres szkennelés után hívandó: egy elbukott szkennelés nem „üres registry".
   */
  pruneAbsent(liveSessionIds: ReadonlySet<string>): void {
    const now = this.#clock.now()
    this.#closeWhere((pending) => {
      if (liveSessionIds.has(pending.view.sessionId)) {
        pending.absentSince = undefined
        return false
      }
      pending.absentSince ??= now
      return pending.view.released && now - pending.absentSince >= ABSENT_SESSION_GRACE_MS
    })
  }

  /** Minden tartott kérés elengedése — a daemon leállásakor, a `server.close()` ELŐTT. */
  releaseAll(): void {
    this.#closed = true
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timer)
      pending.detach()
      pending.respond(undefined)
    }
    this.#pending.clear()
    this.#emit()
  }

  views(): PendingDecisionView[] {
    return [...this.#pending.values()].map((pending) => pending.view).sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * A legrégebbi, még párosítatlan azonos PreToolUse. Mért sorrend: PreToolUse, majd ~15 ms-mal
   * később a PermissionRequest, és a Claude Code a kéréseket a hívások sorrendjében küldi. Két
   * azonos hívásnál a Pre(id1), Pre(id2), A, B sorrendben az A az id1-é — a legújabbtól keresve
   * felcserélődnének, és az id1 PostToolUse-a a B-t zárná le. Az összefésült Pre(id1), A,
   * Pre(id2), B sorrendre is ez a helyes.
   */
  #takeRecentPre(key: string): string | undefined {
    const now = this.#clock.now()
    const index = this.#recentPre.findIndex((entry) => entry.key === key && now - entry.at < PRE_TOOL_USE_TTL_MS)
    if (index === -1) return undefined
    const [entry] = this.#recentPre.splice(index, 1)
    return entry?.toolUseId
  }

  #release(id: string): void {
    const pending = this.#pending.get(id)
    if (pending === undefined || pending.view.released) return
    // A válasz elment, a kapcsolat ezzel rendben lezárul: a bontás figyelése innen fölösleges.
    pending.detach()
    pending.respond(undefined)
    // A sor marad: a natív prompt is marad. Lezárni a PostToolUse, a Stop / SessionEnd /
    // SubagentStop, vagy — ha a session eltűnt a registry-ből — a pruneAbsent fogja.
    pending.view = { ...pending.view, released: true }
    this.#emit()
  }

  #finish(id: string, body: HookDecisionBody | undefined, change: DecisionChange = NO_ABORT): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#clock.clearTimeout(pending.timer)
    pending.detach()
    pending.respond(body)
    this.#pending.delete(id)
    this.#emit(change)
  }

  #closeWhere(predicate: (pending: Pending) => boolean): void {
    for (const [id, pending] of [...this.#pending]) {
      if (predicate(pending)) this.#finish(id, undefined)
    }
  }

  #emit(change: DecisionChange = NO_ABORT): void {
    for (const listener of this.#listeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('[decisions] listener failed', error)
      }
    }
  }
}
