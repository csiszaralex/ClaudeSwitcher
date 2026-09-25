import { useEffect, useRef, useState, type JSX } from 'react'
import { formatDuration, formatResetsIn, summarize } from './format.js'
import { moveSelection, resolveSelectedIndex } from './selection.js'
import { useDaemonState } from './useDaemonState.js'
import './styles.css'

const STATUS_LABEL = {
  waiting: '●',
  working: '◐',
  idle: '○',
  unknown: '?',
} as const

export function App(): JSX.Element {
  const { sessions, rateLimits, connected } = useDaemonState()
  // Session-azonosító, nem index: a lista átrendeződésekor a kiválasztás a sessionnel
  // együtt mozog. Lásd a selection.ts dokumentációját.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())

  const selected = resolveSelectedIndex(
    sessions.map((s) => s.sessionId),
    selectedId,
  )

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
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
      const ids = sessions.map((s) => s.sessionId)
      if (event.key === 'Escape') void window.claudeswitcher.hide()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Enélkül a nyíl a listát is elscrollozná a kijelölés mozgatása mellett.
        event.preventDefault()
        setSelectedId(moveSelection(ids, selectedId, event.key === 'ArrowDown' ? 1 : -1))
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const view = sessions[resolveSelectedIndex(ids, selectedId)]
        if (view !== undefined) void window.claudeswitcher.focusSession(view.sessionId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessions, selectedId])

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
        {sessions.map((view, index) => (
          <li
            key={view.sessionId}
            ref={index === selected ? selectedRow : null}
            className={`session ${view.status} ${index === selected ? 'selected' : ''}`}
            onClick={() => void window.claudeswitcher.focusSession(view.sessionId)}
          >
            <span className="marker">{STATUS_LABEL[view.status]}</span>
            <span className="name">
              {view.name}
              {(view.bridgeSessionId === null || view.bridgeSessionId === undefined) && (
                // Remote Control nélkül ez a session telefonról nem érhető el.
                <span className="unbridged" title="Nincs Remote Control kapcsolata">
                  {' ⚑'}
                </span>
              )}
            </span>
            <span className="summary">{summarize(view)}</span>
            <span className="age">
              {view.waitingSince !== undefined ? formatDuration(now - view.waitingSince) : ''}
            </span>
          </li>
        ))}
      </ul>

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
        {rateLimits.five_hour === undefined && rateLimits.seven_day === undefined && (
          <span className="muted">Limitadat még nincs</span>
        )}
        {!connected && <span className="muted">kapcsolat megszakadt — újracsatlakozás…</span>}
      </div>
    </div>
  )
}
