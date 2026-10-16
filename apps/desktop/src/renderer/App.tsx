import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useRef, useState, type JSX } from 'react'
import { DecisionPanel } from './DecisionPanel.js'
import { isTypingTarget, readOverlaySettings } from './decision-actions.js'
import { formatDuration, formatResetsIn, summarize } from './format.js'
import { moveSelection, nextAfterDecision, resolveSelectedIndex, selectOnShow } from './selection.js'
import { hasRemoteControl, statusMarker } from './session-marker.js'
import { useDaemonState } from './useDaemonState.js'
import './styles.css'

export function App(): JSX.Element {
  const { sessions, rateLimits, connected, checkedAt, decisions } = useDaemonState()
  // Session-azonosító, nem index: a lista átrendeződésekor a kiválasztás a sessionnel
  // együtt mozog. Lásd a selection.ts dokumentációját.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())

  const selected = resolveSelectedIndex(
    sessions.map((s) => s.sessionId),
    selectedId,
  )
  const selectedView = selected === -1 ? undefined : sessions[selected]

  // Sessionönként a függő döntések, a legrégebbi elöl — a daemon létrehozás szerint rendezve
  // küldi. A panel a legrégebbit mutatja; az állapotjelnek mind kell (elengedett-e mind).
  const decisionsBySession = new Map<string, PendingDecisionView[]>()
  for (const decision of decisions) {
    const list = decisionsBySession.get(decision.sessionId)
    if (list === undefined) decisionsBySession.set(decision.sessionId, [decision])
    else list.push(decision)
  }
  const decision = selectedView === undefined ? undefined : decisionsBySession.get(selectedView.sessionId)?.[0]

  // A legutóbbi állapot az aszinkron kezelőknek (megjelenés, döntés utáni léptetés). Egy
  // renderkori closure a döntés válaszáig vagy a megjelenésig elavulhat — a lépést a
  // legfrissebb listán kell kiszámolni, különben egy közben eltűnt sessionre ugorhatna.
  const latest = useRef({ sessions, decisions })
  useEffect(() => {
    latest.current = { sessions, decisions }
  })

  // Megjelenéskor a legrégebben várakozó sessionre ugrunk. A jel a main `show` eseménye (az
  // indoklás a main createOverlay-ében).
  useEffect(
    () =>
      window.claudeswitcher.onShown(() => {
        setSelectedId((current) => selectOnShow(latest.current.sessions, latest.current.decisions, current))
      }),
    [],
  )

  /** Egy appból hozott SIKERES döntés után: a következő várakozóra lép, vagy elrejtőzik. */
  async function afterDecision(decided: PendingDecisionView): Promise<void> {
    // Minden döntésnél frissen kérdezzük: a tálcapipa bármikor átállhat, és egy gyorsítótár
    // ehhez külön értesítési csatornát kívánna. Ha az IPC elbukik, az alapérték (elrejtés) jön.
    const raw = await window.claudeswitcher.settings().catch((error: unknown) => {
      console.error('[overlay] could not read the settings', error)
      return undefined
    })
    const { hideAfterLastDecision } = readOverlaySettings(raw)
    const next = nextAfterDecision(latest.current.sessions, latest.current.decisions, decided, hideAfterLastDecision)
    if (next.select !== undefined) setSelectedId(next.select)
    if (next.hide) await window.claudeswitcher.hide()
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])

  // A kijelölt sor legördítése. A lista scrollozható, tehát nélküle a nyilakkal a
  // kijelölés kifuthat a látható területről, és az Enter egy olyan sessiont aktiválna,
  // amit a felhasználó nem is lát — a legrosszabb fajta hiba ebben az appban, mert
  // ugyanúgy „működik", csak nem azt teszi, amit vártál.
  const selectedRow = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // Szövegmezőben a gépelés az övé: se a nyilak, se az Enter, se az Esc ne vezérelje a listát.
      if (isTypingTarget(event.target)) return
      const ids = sessions.map((s) => s.sessionId)
      if (event.key === 'Escape') void window.claudeswitcher.hide()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Enélkül a nyíl a listát is elscrollozná a kijelölés mozgatása mellett.
        event.preventDefault()
        setSelectedId(moveSelection(ids, selectedId, event.key === 'ArrowDown' ? 1 : -1))
      }
      // Nyitott döntési panelnél a Tab a gombok között lép — ott nem ugrás.
      if (event.key === 'Enter' || (event.key === 'Tab' && decision === undefined)) {
        event.preventDefault()
        const view = sessions[resolveSelectedIndex(ids, selectedId)]
        if (view !== undefined) void window.claudeswitcher.focusSession(view.sessionId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [sessions, selectedId, decision])

  return (
    <div className="overlay">
      <ul className="sessions">
        {sessions.length === 0 && (
          // „Nincs session" és „nem érjük el a daemont" nem ugyanaz — a felhasználónak
          // látnia kell, melyikről van szó.
          <li className="empty">
            {connected ? 'Nincs futó session' : 'Nincs kapcsolat a daemonnal…'}
          </li>
        )}
        {sessions.map((view, index) => {
          const sessionDecisions = decisionsBySession.get(view.sessionId) ?? []
          const pending = sessionDecisions[0]
          const marker = statusMarker(view, sessionDecisions)
          return (
            <li
              key={view.sessionId}
              ref={index === selected ? selectedRow : null}
              className={`session ${view.status} ${index === selected ? 'selected' : ''}`}
              onClick={() => {
                setSelectedId(view.sessionId)
              }}
              onDoubleClick={() => {
                void window.claudeswitcher.focusSession(view.sessionId)
              }}
            >
              <span className={`marker tone-${marker.tone}`} title={marker.title}>
                {marker.glyph}
              </span>
              <span className="name">
                {/* Csak a szöveg csonkolódik (…), a pötty soha: hosszú névnél is látszania kell. */}
                <span className="name-text">{view.name}</span>
                {hasRemoteControl(view) && (
                  <span className="remote" title="Remote Control: telefonról is elérhető">
                    ●
                  </span>
                )}
              </span>
              <span className="summary">
                {pending === undefined ? summarize(view) : `${pending.toolName}: ${pending.summary}`}
              </span>
              <span className="age">
                {view.waitingSince !== undefined ? formatDuration(now - view.waitingSince) : ''}
              </span>
            </li>
          )
        })}
      </ul>

      {decision !== undefined && selectedView !== undefined && (
        <DecisionPanel
          key={decision.id}
          decision={decision}
          onDecided={() => {
            afterDecision(decision).catch((error: unknown) => {
              console.error('[overlay] could not move on after the decision', error)
            })
          }}
          onJump={() => {
            void window.claudeswitcher.focusSession(selectedView.sessionId)
          }}
        />
      )}

      <div className="limits">
        {rateLimits.five_hour !== undefined && (
          <span>
            5h {Math.round(rateLimits.five_hour.used_percentage)}% ·{' '}
            {formatResetsIn(rateLimits.five_hour.resets_at, now)}
          </span>
        )}
        {rateLimits.seven_day !== undefined && (
          <span>
            7d {Math.round(rateLimits.seven_day.used_percentage)}% ·{' '}
            {formatResetsIn(rateLimits.seven_day.resets_at, now)}
          </span>
        )}
        {/*
          Az életjel ideje. Ez az egyetlen jel, amiből látszik, hogy a lista ÉL, csak nincs
          változás — a daemon az azonos pillanatképet nem küldi újra, tehát egy tétlen gépen
          a mozdulatlan lista és a megállt poll különben pont ugyanúgy néz ki.
        */}
        <span className="muted">
          {checkedAt === undefined
            ? 'ellenőrizve: még nem'
            : `ellenőrizve: ${formatDuration(now - checkedAt)}`}
        </span>
        {!connected && <span className="muted">kapcsolat megszakadt — újracsatlakozás…</span>}
      </div>
    </div>
  )
}
