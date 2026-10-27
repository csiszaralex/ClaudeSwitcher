import type { LiveSession, SessionActivity, SessionView, SubagentView } from '@claudeswitcher/core'
import type { LifecycleEvent, NotificationEvent } from './hook-server.js'

/**
 * Meddig tartunk meg egy olyan várakozást, aminek a sessionje még nem szerepel a
 * pillanatképben. Bőven több, mint a 3 másodperces poll — de nem végtelen, hogy egy soha
 * meg nem jelenő session ne szivárogjon.
 */
const UNMATCHED_WAIT_GRACE_MS = 10_000

/**
 * Az app döntése után ennyi ideig nem veszünk várakozásnak egy `permission_prompt`
 * Notificationt. A Claude Code ezt ~6 mp-cel a PermissionRequest UTÁN küldi (mérve, Task 10 A),
 * akkor is, ha az appban addigra már döntöttek — enélkül a gyorsan eldöntött session a
 * Notification megérkezésekor újra „waiting" lenne, és a Stop-ig az is maradna. 10 mp: a mért
 * 6 mp fölött van tartalék, de egy valóban új prompt nem vész el, mert annak saját
 * PermissionRequest-je a függő döntésen át úgyis várakozónak mutatja a sessiont.
 */
const LATE_PROMPT_WINDOW_MS = 10_000

const WAITING_TYPES = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])

interface WaitState {
  since: number
  text?: string | undefined
}

function displayName(record: LiveSession['record']): string {
  if (record.name !== undefined && record.name !== '') return record.name
  const parts = record.cwd.split(/[\\/]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? record.sessionId
}

/**
 * A UI-nak küldött állapot egyetlen forrása. Négy bemenetet egyesít:
 * a periodikus snapshotot (registry + transcript), a hook-eseményeket, az
 * életciklus-eseményeket és a függő döntéseket. Ütközésnél a hook nyer: a snapshot a
 * transcriptből származik és lemaradhat, a hook viszont a történés pillanatában érkezik.
 *
 * Egy session akkor várakozó, ha van Notification-várakozása, függő döntése, VAGY a registry
 * `status: 'waiting'`-et mutat. Amikor mind megszűnik, feljegyezzük, mikor: a nem-várók ennek
 * alapján rendeződnek.
 *
 * A registry-forrás az app-újraindulás esetére kell: a régi daemonhoz ment PermissionRequest és
 * az egyszeri Notification nem ismétlődik, a várakozást csak a registry tudja. Csak megjelenítés:
 * döntést soha nem hoz létre, nem válaszol meg és nem zár le. Ütközésnél a hook nyer — lásd
 * `#clearedAt`.
 */
export class SessionStore {
  #sessions = new Map<string, LiveSession>()
  #activities = new Map<string, SessionActivity>()
  /** Sessionönként az aktív subagentek a legutóbbi pillanatképből. Csak megjelenítés. */
  #subagents: ReadonlyMap<string, readonly SubagentView[]> = new Map()
  readonly #waiting = new Map<string, WaitState>()
  /** Sessionönként a legrégebbi függő (vagy elengedett, de még nyitott) döntés kezdete. */
  #pending: ReadonlyMap<string, number> = new Map()
  /** Mikor szűnt meg utoljára a session várakozása. Csak a rendezéshez. */
  readonly #waitEndedAt = new Map<string, number>()
  /** Mikor döntött utoljára az app a session egy kéréséről — a késő Notificationhöz. */
  readonly #resolvedAt = new Map<string, number>()
  /** Az utolsó Stop ideje, amíg a session újra nem mozdul — a „épp végzett" jelzéshez. */
  readonly #stoppedAt = new Map<string, number>()
  /**
   * Mikor zárta le utoljára egy hook (PostToolUse, Stop, SessionEnd, nem-várakozó Notification)
   * vagy az app döntése a session várakozását. A registry ennél NEM újabb `waiting`-je elavult.
   *
   * Miért nem a `#resolvedAt` 10 mp-es ablaka: a registry lemaradása nem egy mért, rögzített
   * késés (mint a Notificationé), hanem a poll üteme plusz a Claude Code írása — egy ablak vagy
   * elnyelne egy valóban új várakozást, vagy a lejárta után feltámasztaná a régit, ha a registry
   * addig nem írt újat. A `statusUpdatedAt` viszont pontosan megmondja, a lezárás előtt vagy után
   * kezdődött-e a várakozás: ugyanaz a gép, ugyanaz az óra, és a hook nálunk mindig az esemény
   * UTÁN jár, tehát a régi várakozás bélyege mindig kisebb.
   */
  readonly #clearedAt = new Map<string, number>()
  readonly #listeners: Array<() => void> = []

  onChange(listener: () => void): void {
    this.#listeners.push(listener)
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[store] listener failed', error)
      }
    }
  }

  #isWaiting(sessionId: string): boolean {
    return (
      this.#waiting.has(sessionId) || this.#pending.has(sessionId) || this.#registryWaitSince(sessionId) !== undefined
    )
  }

  /**
   * A registry szerinti várakozás kezdete, ha a session most is vár. `statusUpdatedAt` nélkül nem
   * tudjuk a hookokhoz mérni, tehát nem is vesszük figyelembe (spec §8: a régi viselkedés).
   */
  #registryWaitSince(sessionId: string): number | undefined {
    const record = this.#sessions.get(sessionId)?.record
    if (record?.status !== 'waiting' || record.statusUpdatedAt === undefined) return undefined
    const cleared = this.#clearedAt.get(sessionId)
    if (cleared !== undefined && record.statusUpdatedAt <= cleared) return undefined
    return record.statusUpdatedAt
  }

  /**
   * Dolgozik-e a session a registry szerint — akkor is, ha épp nem fut tool (gondolkodik, szöveget
   * ír). A Stop előtti `busy` a lemaradt pillanatkép maradéka: a session épp végzett.
   */
  #registryBusy(sessionId: string): boolean {
    const record = this.#sessions.get(sessionId)?.record
    if (record?.status !== 'busy' || record.statusUpdatedAt === undefined) return false
    const stopped = this.#stoppedAt.get(sessionId)
    return stopped === undefined || record.statusUpdatedAt > stopped
  }

  /** Egy hook lezárta a várakozást: a Notification-várakozás megy, a registry régi `waiting`-je elavul. */
  #clearWait(sessionId: string, now: number): void {
    this.#waiting.delete(sessionId)
    this.#clearedAt.set(sessionId, now)
  }

  /**
   * Lefuttatja a változtatást, és feljegyzi a várakozás végét azoknál a sessionöknél, amelyek
   * előtte vártak, utána már nem. Egy helyen, hogy egyik út (döntés, PostToolUse, Stop,
   * nem-várakozó Notification) se felejtse el.
   */
  #tracking(sessionIds: Iterable<string>, now: number, change: () => void): void {
    const before = [...sessionIds].filter((id) => this.#isWaiting(id))
    change()
    for (const id of before) {
      if (!this.#isWaiting(id)) this.#waitEndedAt.set(id, now)
    }
  }

  /**
   * @param subagents — sessionönként az aktív subagentek, a legutóbb írt elöl (a scanner adja).
   * Egy hiányzó bejegyzés: a sessionnek nincs aktív subagentje.
   */
  applySnapshot(
    sessions: LiveSession[],
    activities: Map<string, SessionActivity>,
    now: number = Date.now(),
    subagents: ReadonlyMap<string, readonly SubagentView[]> = new Map(),
  ): void {
    const ids = new Set(sessions.map((s) => s.record.sessionId))
    // A registry `waiting`-je a pillanatképpel jön és megy: a várakozás vége innen is eredhet.
    this.#tracking(new Set([...this.#sessions.keys(), ...ids]), now, () => {
      this.#sessions = new Map(sessions.map((s) => [s.record.sessionId, s]))
    })
    this.#activities = activities
    this.#subagents = subagents

    // Futó tool a pillanatképben: a session a Stop után újra dolgozik.
    for (const [id, activity] of activities) {
      if (activity.runningTool !== undefined) this.#stoppedAt.delete(id)
    }
    // Ugyanígy egy subagent futó toolja: a háttér-subagent a fő kör Stop-ja után is dolgozik.
    for (const [id, list] of subagents) {
      if (list.some((subagent) => subagent.runningTool !== undefined)) this.#stoppedAt.delete(id)
    }
    // Ugyanígy egy, a Stop UTÁN kezdődött registry-`busy` vagy -`waiting`: új kör indult. A Stop
    // előtti a lemaradt pillanatkép maradéka, az nem törli az „épp végzett"-et.
    for (const { record } of sessions) {
      const stopped = this.#stoppedAt.get(record.sessionId)
      const changedAt = record.statusUpdatedAt
      if (stopped === undefined || changedAt === undefined || changedAt <= stopped) continue
      if (record.status === 'busy' || record.status === 'waiting') this.#stoppedAt.delete(record.sessionId)
    }

    for (const [id, wait] of [...this.#waiting]) {
      if (ids.has(id)) continue
      // Egy FRISS várakozást nem dobunk el csak azért, mert a session még nem került be a
      // registry-be: a hook azonnal megérkezik, a registry-t viszont csak pár másodpercenként
      // olvassuk. A türelmi idő után viszont takarítunk, különben egy soha meg nem jelenő
      // session várakozása örökre a memóriában maradna.
      if (now - wait.since < UNMATCHED_WAIT_GRACE_MS) continue
      this.#waiting.delete(id)
    }
    // Ugyanez a takarítás az időbélyegekre: egy eltűnt session ne szivárogjon.
    for (const stamps of [this.#waitEndedAt, this.#stoppedAt, this.#clearedAt]) {
      for (const [id, at] of [...stamps]) {
        if (!ids.has(id) && now - at >= UNMATCHED_WAIT_GRACE_MS) stamps.delete(id)
      }
    }
    for (const [id, at] of [...this.#resolvedAt]) {
      if (now - at >= LATE_PROMPT_WINDOW_MS) this.#resolvedAt.delete(id)
    }
    this.#emit()
  }

  /**
   * Akkor is eltárolja a várakozást, ha a session még ismeretlen.
   *
   * A `views()` a sessionökön iterál, tehát egy párját nem talált bejegyzés láthatatlan —
   * viszont amint a következő pillanatkép felveszi a sessiont, azonnal `waiting`-ként
   * jelenik meg. Korábban az ilyen értesítés VÉGLEGESEN elveszett, és a felhasználó egy rá
   * várakozó sessiont látott idle-ként.
   */
  applyNotification(event: NotificationEvent, now: number = Date.now()): void {
    const resolvedAt = this.#resolvedAt.get(event.sessionId)
    const late =
      event.type === 'permission_prompt' && resolvedAt !== undefined && now - resolvedAt < LATE_PROMPT_WINDOW_MS
    this.#tracking([event.sessionId], now, () => {
      // A már eldöntött kérés késve érkező promptja — lásd LATE_PROMPT_WINDOW_MS.
      if (late) return
      if (WAITING_TYPES.has(event.type)) {
        this.#waiting.set(event.sessionId, { since: now, text: event.text })
        this.#stoppedAt.delete(event.sessionId)
      } else {
        this.#clearWait(event.sessionId, now)
      }
    })
    this.#emit()
  }

  applyLifecycle(event: LifecycleEvent, now: number = Date.now()): void {
    this.#tracking([event.sessionId], now, () => {
      if (event.kind === 'end') {
        this.#sessions.delete(event.sessionId)
      }
      this.#clearWait(event.sessionId, now)
    })
    if (event.kind === 'stop') this.#stoppedAt.set(event.sessionId, now)
    // A véget ért session nem „épp végzett": ha a registry még egy körig mutatja, ne így jöjjön vissza.
    if (event.kind === 'end') this.#stoppedAt.delete(event.sessionId)
    this.#emit()
  }

  /**
   * A session egy tool-hívásba kezdett (PreToolUse). A Stop utáni „épp végzett" jelzés ezzel
   * elavul: a session újra dolgozik. A pillanatkép ezt csak késve, a transcriptből látná.
   */
  applyToolStarted(sessionId: string): void {
    this.#stoppedAt.delete(sessionId)
    this.#emit()
  }

  /**
   * A session egy tool-ja lefutott (PostToolUse). A prompt tehát megválaszolódott — az appban,
   * a VSCode-ban vagy a telefonon —, a Notification-várakozás így elavult. Egy MÁSIK, még függő
   * vagy elengedett döntés a `#pending`-en át továbbra is várakozónak mutatja a sessiont.
   */
  applyToolFinished(sessionId: string, now: number = Date.now()): void {
    this.#tracking([sessionId], now, () => {
      this.#clearWait(sessionId, now)
    })
    this.#emit()
  }

  /**
   * A függő döntések aktuális állapota a brokertől, minden változásakor.
   *
   * @param pendingSince — sessionönként a legrégebbi függő döntés kezdete. Egy ilyen session
   * akkor is várakozó, ha a Notification még nem jött meg: az csak ~6 mp függés után érkezik
   * (mérve), a PermissionRequest viszont azonnal. Az elengedett (590 mp) döntés is benne van:
   * a natív prompt ilyenkor még nyitva van.
   * @param resolvedByApp — a session, amelynek a döntését ez a változás az appban zárta le. Az ő
   * Notification-várakozását EGY lépésben töröljük a függéssel: két külön frissítés között a
   * renderer egy pillanatra egy már eldöntött, de még „waiting" sessiont látna.
   * @param abortedByClient A session, amelynek az utolsó tartott kérését a hook-kliens bontása
   * zárta le. Natív Nem vagy Esc után a Claude Code semmilyen hookot nem küld, csak bontja a
   * kapcsolatot (mérve, 2026-10-25), tehát a Notification-várakozást csak ez törölheti. Ugyanabban
   * a lépésben, mint az app döntésénél, de a késő promptok ablaka (`#resolvedAt`) NEM nyílik meg:
   * az az app döntésének versenyhelyzetére való, natív válasz után egy új prompt valódi várakozás.
   */
  applyPending(
    pendingSince: ReadonlyMap<string, number>,
    now: number = Date.now(),
    resolvedByApp?: string,
    abortedByClient?: string,
  ): void {
    const affected = new Set(this.#pending.keys())
    if (resolvedByApp !== undefined) affected.add(resolvedByApp)
    if (abortedByClient !== undefined) affected.add(abortedByClient)
    // Egy újonnan függő döntés egy új PermissionRequest: a session a Stop után újra mozdult.
    for (const id of pendingSince.keys()) {
      if (!this.#pending.has(id)) this.#stoppedAt.delete(id)
    }
    this.#tracking(affected, now, () => {
      this.#pending = new Map(pendingSince)
      if (resolvedByApp !== undefined) {
        this.#clearWait(resolvedByApp, now)
        this.#resolvedAt.set(resolvedByApp, now)
      }
      if (abortedByClient !== undefined) this.#clearWait(abortedByClient, now)
    })
    this.#emit()
  }

  views(): SessionView[] {
    const views: SessionView[] = []

    for (const [sessionId, session] of this.#sessions) {
      const activity = this.#activities.get(sessionId) ?? {}
      const wait = this.#waiting.get(sessionId)
      const pending = this.#pending.get(sessionId)
      const registryWait = this.#registryWaitSince(sessionId)
      const subagents = this.#subagents.get(sessionId) ?? []
      const subagentWorking = subagents.some((subagent) => subagent.runningTool !== undefined)

      // A várakozás (hook, döntés, registry) a subagent munkája előtt is nyer.
      const status =
        wait !== undefined || pending !== undefined || registryWait !== undefined ? 'waiting'
        : activity.runningTool !== undefined || subagentWorking || this.#registryBusy(sessionId) ? 'working'
        : 'idle'

      views.push({
        sessionId,
        pid: session.record.pid,
        name: displayName(session.record),
        cwd: session.record.cwd,
        status,
        activity,
        windowPid: session.window?.pid,
        workspaceFolder: session.window?.workspaceFolders[0],
        bridgeSessionId: session.record.bridgeSessionId,
        entrypoint: session.record.entrypoint,
        // A hook-források pontosabbak; a registry csak akkor, ha egyikük sem tud a várakozásról.
        waitingSince: wait?.since ?? pending ?? registryWait,
        notificationText: wait?.text,
        // Aktív subagent mellett nincs „épp végzett": a háttérmunka a fő kör Stop-ja után is tart.
        // Csak elfedjük, nem töröljük — a két tool közt gondolkodó subagent nem új tevékenység, és
        // ha eltűnik, a régi Stop újra látszik.
        stoppedAt: subagents.length > 0 ? undefined : this.#stoppedAt.get(sessionId),
        ...(subagents.length > 0 ? { subagents: [...subagents] } : {}),
      })
    }

    // Várakozók elöl, a legrégebben váró legfelül. Utána a nem-várók: a legutóbb várakozni
    // megszűnt elöl (a felhasználó kérése, Task 10 B: a frissen eldöntött session ne név
    // szerint „random a közepére" essen); végül a daemon élete alatt sosem várók, név szerint.
    return views.sort((a, b) => {
      if (a.status === 'waiting' && b.status !== 'waiting') return -1
      if (b.status === 'waiting' && a.status !== 'waiting') return 1
      if (a.status === 'waiting' && b.status === 'waiting') {
        return (a.waitingSince ?? 0) - (b.waitingSince ?? 0)
      }
      const endedA = this.#waitEndedAt.get(a.sessionId)
      const endedB = this.#waitEndedAt.get(b.sessionId)
      if (endedA !== undefined && endedB === undefined) return -1
      if (endedB !== undefined && endedA === undefined) return 1
      if (endedA !== undefined && endedB !== undefined && endedA !== endedB) return endedB - endedA
      return a.name.localeCompare(b.name)
    })
  }
}
