import type { UserDecision } from '@claudeswitcher/core'
import { useEffect, useState } from 'react'
import { parseDaemonMessage, sanitizeState, type DaemonState } from './state-message.js'

declare global {
  interface Window {
    claudeswitcher: {
      connection(): Promise<{ port: number; token: string }>
      state(): Promise<DaemonState>
      focusSession(sessionId: string): Promise<boolean>
      hide(): Promise<void>
      /** A main `DecideResult`-ot ad; a renderer a `readDecideResult`-tal olvassa (Task 8). */
      decide(id: string, decision: UserDecision): Promise<unknown>
      /** A main beállításai; a renderer a `readOverlaySettings`-szel olvassa. */
      settings(): Promise<unknown>
      /** Hív, valahányszor az overlay láthatóvá válik; a visszaadott függvény leiratkozik. */
      onShown(callback: () => void): () => void
    }
  }
}

export interface OverlayState extends DaemonState {
  /** Hamis, amíg nincs élő kapcsolat a daemonnal — a lista ilyenkor állott lehet. */
  connected: boolean
  /**
   * Mikor jelzett utoljára a daemon, hogy végigszkennelte a sessionöket (`Date.now()`).
   * `undefined`, amíg nem jött jel. Nem az utolsó VÁLTOZÁS ideje: a daemon az azonos
   * pillanatképet nem küldi újra, tehát a „nincs változás" és a „megállt" csak ezen a
   * jelen keresztül különböztethető meg.
   */
  checkedAt: number | undefined
  /**
   * Hányadik alkalmazott állapotüzenet (élő `state` üzenet vagy a kezdeti IPC-lekérés). A legfelső
   * ErrorBoundary ebből tudja, hogy új állapot jött, és újra megpróbálhatja a renderelést. Az
   * életjel (`tick`) nem növeli: az azonos állapot ugyanúgy hibázna.
   */
  stateVersion: number
}

/**
 * Várakozás a hányadik újracsatlakozási próbálkozás előtt. Negyed másodpercről indul, és
 * tíz másodpercnél megáll: egy alvásból ébredt gép gyorsan visszakapcsolódik, egy tartósan
 * halott daemont viszont nem ostromlunk.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** Math.max(0, attempt - 1))
}

/** Élő állapot a daemon WebSocket hubjáról, újracsatlakozással. */
export function useDaemonState(): OverlayState {
  const [state, setState] = useState<DaemonState>({ sessions: [], decisions: [] })
  const [connected, setConnected] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | undefined>()
  const [stateVersion, setStateVersion] = useState(0)

  useEffect(() => {
    let socket: WebSocket | undefined
    let closed = false
    const isClosed = (): boolean => closed
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    // Ha már érkezett élő üzenet, egy később befutó IPC-lekérés nem írhatja felül: a két
    // csatorna külön utazik, és nincs köztük sorrendi garancia.
    let receivedLive = false
    // Kapcsolat-nemzedék. Újracsatlakozáskor nő, és minden kezelő a SAJÁT nemzedékére
    // ellenőriz. Enélkül egy előző, már lezárt kapcsolat közben indított állapot-lekérés
    // később futhatna be, mint egy újabb kapcsolat adata, és felülírná frissebbel. A
    // `receivedLive` önmagában nem véd ettől: azt az `onclose` nullázza.
    let generation = 0

    const scheduleRetry = (): void => {
      if (closed) return
      attempt += 1
      retry = setTimeout(attemptConnect, retryDelayMs(attempt))
    }

    const connect = async (): Promise<void> => {
      if (closed) return
      const myGeneration = ++generation

      const { port, token } = await window.claudeswitcher.connection()
      // Az `await` alatt a `closed` megváltozhat; a függvényhívás megakadályozza, hogy a
      // fordító a korábbi `if (closed)` után végleg hamisnak vegye.
      if (isClosed() || myGeneration !== generation) return

      const next = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
      socket = next

      next.onopen = () => {
        if (closed || myGeneration !== generation) return
        attempt = 0
        setConnected(true)
        // Az állapotot szándékosan CSAK a kapcsolat megnyílása után kérjük le. Egy
        // megnyílás előtti lekérés és a socket élete között érkező változás elveszne, és
        // mivel a daemon az azonos pillanatképeket nem küldi újra, az overlay addig
        // állott maradna, amíg valami ÚJRA meg nem változik.
        // A sanitizeState itt sem hagyható el: az IPC-s út nem megy át a
        // parseStateMessage-en, tehát e nélkül csak a WebSocket lenne védve a hibás
        // alaktól. A `.catch` azért van, mert egy elkapatlan elutasítás a rendererben
        // néma lenne.
        void window.claudeswitcher
          .state()
          .then((fresh) => {
            const clean = sanitizeState(fresh)
            if (clean === undefined) return
            if (!closed && myGeneration === generation && !receivedLive) {
              setState(clean)
              setStateVersion((version) => version + 1)
            }
          })
          .catch((error: unknown) => {
            console.error('[overlay] could not read the initial state', error)
          })
        // A korlátos indítás ezt a sort keresi: a rejtett overlay is betölti az oldalát,
        // így ez bizonyítja, hogy a React lefutott, az IPC válaszolt, és a WebSocket a
        // tokennel kapcsolódott. Tokent nem ír ki.
        console.info('[overlay] live updates connected')
      }

      next.onmessage = (event) => {
        if (closed || myGeneration !== generation) return
        const parsed = parseDaemonMessage(event.data)
        if (parsed === undefined) return
        // Bármelyik érthető üzenet azt bizonyítja, hogy a daemon épp most szkennelt.
        setCheckedAt(Date.now())
        if (parsed.kind !== 'state') return
        receivedLive = true
        setState(parsed.state)
        setStateVersion((version) => version + 1)
      }

      next.onclose = () => {
        if (closed || myGeneration !== generation) return
        // Kapcsolatvesztés után az overlay némán állott maradna — egy monitorozó
        // eszközben ez ugyanolyan rossz, mint a hibás adat. Újracsatlakozunk, és addig
        // a felhasználó is látja, hogy nincs élő kapcsolat.
        setConnected(false)
        receivedLive = false
        scheduleRetry()
      }

      next.onerror = () => {
        // A `close` mindig követi; az újracsatlakozást ott ütemezzük.
        next.close()
      }
    }

    // MINDEN próbálkozás ezen megy át, az újraütemezettek is. Ha csak az első kapna
    // `catch`-et, egy későbbi próbálkozás elutasítása — például ha az IPC nem válaszol —
    // elkapatlan maradna, ÉS a ciklus némán leállna: több újraütemezés nem történne, az
    // overlay pedig örökre „nincs kapcsolat" állapotban maradna.
    function attemptConnect(): void {
      connect().catch((error: unknown) => {
        console.error('[overlay] could not reach the daemon', error)
        scheduleRetry()
      })
    }

    attemptConnect()

    return () => {
      closed = true
      if (retry !== undefined) clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return { ...state, connected, checkedAt, stateVersion }
}
