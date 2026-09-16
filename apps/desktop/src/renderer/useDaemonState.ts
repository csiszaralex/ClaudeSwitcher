import { useEffect, useState } from 'react'
import { parseStateMessage, type DaemonState } from './state-message.js'

declare global {
  interface Window {
    claudeswitcher: {
      connection(): Promise<{ port: number; token: string }>
      state(): Promise<DaemonState>
      focusSession(sessionId: string): Promise<boolean>
      hide(): Promise<void>
    }
  }
}

export interface OverlayState extends DaemonState {
  /** Hamis, amíg nincs élő kapcsolat a daemonnal — a lista ilyenkor állott lehet. */
  connected: boolean
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
  const [state, setState] = useState<DaemonState>({ sessions: [], rateLimits: {} })
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let socket: WebSocket | undefined
    let closed = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    // Ha már érkezett élő üzenet, egy később befutó IPC-lekérés nem írhatja felül: a két
    // csatorna külön utazik, és nincs köztük sorrendi garancia.
    let receivedLive = false

    const scheduleRetry = (): void => {
      if (closed) return
      attempt += 1
      retry = setTimeout(() => void connect(), retryDelayMs(attempt))
    }

    const connect = async (): Promise<void> => {
      if (closed) return
      const { port, token } = await window.claudeswitcher.connection()
      if (closed) return

      const next = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
      socket = next

      next.onopen = () => {
        attempt = 0
        if (closed) return
        setConnected(true)
        // Az állapotot szándékosan CSAK a kapcsolat megnyílása után kérjük le. Egy
        // megnyílás előtti lekérés és a socket élete között érkező változás elveszne, és
        // mivel a daemon az azonos pillanatképeket nem küldi újra, az overlay addig
        // állott maradna, amíg valami ÚJRA meg nem változik.
        void window.claudeswitcher.state().then((fresh) => {
          if (!closed && !receivedLive) setState(fresh)
        })
        // A korlátos indítás ezt a sort keresi: a rejtett overlay is betölti az oldalát,
        // így ez bizonyítja, hogy a React lefutott, az IPC válaszolt, és a WebSocket a
        // tokennel kapcsolódott. Tokent nem ír ki.
        console.info('[overlay] live updates connected')
      }

      next.onmessage = (event) => {
        const parsed = parseStateMessage(event.data)
        if (parsed === undefined || closed) return
        receivedLive = true
        setState(parsed)
      }

      next.onclose = () => {
        if (closed) return
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

    connect().catch((error: unknown) => {
      console.error('[overlay] could not reach the daemon', error)
      scheduleRetry()
    })

    return () => {
      closed = true
      if (retry !== undefined) clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return { ...state, connected }
}
