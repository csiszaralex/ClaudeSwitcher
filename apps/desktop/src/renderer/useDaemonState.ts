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

/** Kezdeti állapot IPC-n, utána élő frissítés a daemon WS hubjáról. */
export function useDaemonState(): DaemonState {
  const [state, setState] = useState<DaemonState>({ sessions: [], rateLimits: {} })

  useEffect(() => {
    let socket: WebSocket | undefined
    let closed = false

    const connect = async (): Promise<void> => {
      setState(await window.claudeswitcher.state())
      const { port, token } = await window.claudeswitcher.connection()
      if (closed) return

      socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)

      socket.onopen = () => {
        // Újralekérés, amikor a kapcsolat már él. A kezdeti lekérés és a megnyílás
        // között érkezett változás különben elveszne — és mivel a daemon az azonos
        // pillanatképeket nem küldi újra, az overlay addig állott maradna, amíg valami
        // ÚJRA meg nem változik.
        void window.claudeswitcher.state().then((fresh) => {
          if (!closed) setState(fresh)
        })
        // A korlátos indítás ezt a sort keresi: a rejtett overlay is betölti az oldalát,
        // így ez bizonyítja, hogy a React lefutott, az IPC válaszolt, és a WebSocket a
        // tokennel kapcsolódott. Tokent nem ír ki.
        console.info('[overlay] live updates connected')
      }

      socket.onmessage = (event) => {
        const next = parseStateMessage(event.data)
        if (next !== undefined) setState(next)
      }
    }

    connect().catch((error: unknown) => {
      // Elkapatlan elutasítás helyett látható hiba — a korlátos indítás ezt is figyeli.
      console.error('[overlay] could not reach the daemon', error)
    })

    return () => {
      closed = true
      socket?.close()
    }
  }, [])

  return state
}
