import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useRef, useState, type JSX } from 'react'
import { DecisionPanel } from './DecisionPanel.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { JumpButton } from './JumpButton.js'
import { isActivationTarget, isTypingTarget, readOverlaySettings } from './decision-actions.js'
import { formatDuration, pendingRowText, subagentLabel, subagentTooltip, summarize } from './format.js'
import { armUntil, type KeyHistory } from './key-guard.js'
import { activeDecision, buildRows, pendingBadge, waitsOutsideApp } from './rows.js'
import { moveSelection, nextAfterDecision, resolveSelectedIndex, selectOnShow, trackArrivals } from './selection.js'
import { hasRemoteControl, statusMarker } from './session-marker.js'
import type { OverlayState } from './useDaemonState.js'
import './styles.css'

/**
 * Stands in for the panel when the app cannot decide: one line of explanation and the jump to VS Code,
 * so the row is not a dead end.
 */
function JumpNotice({ text, sessionId }: { text: string; sessionId: string }): JSX.Element {
  return (
    <section className="decision">
      <div className="decision-actions">
        <div className="decision-row">
          <span className="muted">{text}</span>
          <JumpButton
            onJump={() => {
              void window.claudeswitcher.focusSession(sessionId)
            }}
          />
        </div>
      </div>
    </section>
  )
}

/**
 * @param overlay The daemon's live state. It comes from outside (`main.tsx` `Root`) and is not read
 * here: so the connection lives on after a render error, and the next state can restore the UI.
 */
export function App({ overlay }: { overlay: OverlayState }): JSX.Element {
  const { sessions, connected, checkedAt, decisions } = overlay
  // A session id, not an index: when the list reorders, the selection moves with the session.
  // See the selection.ts documentation.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())

  // The rows: the sessions, plus a row of its own for each pending request whose session the
  // snapshot does not know yet (rows.ts). All selection and stepping works on this list.
  const rows = buildRows(sessions, decisions)
  const ids = rows.map((row) => row.sessionId)
  const selected = resolveSelectedIndex(ids, selectedId)
  const selectedRowView = selected === -1 ? undefined : rows[selected]

  // The panel shows the oldest request the app can still decide; the status marker needs all of them.
  const decision = selectedRowView === undefined ? undefined : activeDecision(selectedRowView.decisions)

  // The latest state for the async handlers (show, the step after a decision). A closure from
  // render time can go stale before the decision's reply or the show: the step has to be computed
  // on the freshest list, else it could jump to a session that has disappeared meanwhile.
  const latest = useRef({ rows, decisions })
  useEffect(() => {
    latest.current = { rows, decisions }
  })

  // For the guard on the panel's key letters (key-guard.ts): when the overlay appeared, and when
  // the user last typed into a text field.
  const keyHistory = useRef<KeyHistory>({ shownArmedAt: 0, lastTypedAt: undefined })
  // Only triggers a re-render on show: from it the panel dims the allowing buttons.
  const [, rerenderOnShow] = useState(0)

  // On a new request the app can decide, the selection jumps to it if the selected row has no
  // decision and the user is not typing (selection.ts `selectOnArrival`). Runs only when the list
  // of requests changed; `trackArrivals` keeps the requests of the previous state.
  const arrivals = useRef(trackArrivals())
  useEffect(() => {
    const next = arrivals.current({
      sessions: rows,
      decisions,
      selectedId: selectedRowView?.sessionId,
      lastTypedAt: keyHistory.current.lastTypedAt,
      now: Date.now(),
    })
    if (next !== undefined) setSelectedId(next)
  }, [decisions])

  // On show, jump to the session that has been waiting longest, and the panel arms again: the first
  // keystroke could still go to the old selection. The signal is the main process's `show` event
  // (the reason is in `createOverlay` in the main process).
  useEffect(
    () =>
      window.claudeswitcher.onShown(() => {
        const armedAt = armUntil(Date.now())
        keyHistory.current.shownArmedAt = armedAt
        rerenderOnShow(armedAt)
        setSelectedId((current) => selectOnShow(latest.current.rows, latest.current.decisions, current))
      }),
    [],
  )

  // The time of every keystroke in a text field, in the capture phase: it is recorded even if the
  // field disappears the next moment (the request was settled elsewhere) and focus falls to the body.
  useEffect(() => {
    function onTyped(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) keyHistory.current.lastTypedAt = Date.now()
    }
    window.addEventListener('keydown', onTyped, true)
    return () => {
      window.removeEventListener('keydown', onTyped, true)
    }
  }, [])

  /** After a SUCCESSFUL decision made in the app: steps to the next waiting one, or hides. */
  async function afterDecision(decided: PendingDecisionView): Promise<void> {
    // Asked fresh on every decision: the tray checkbox can flip at any time, and a cache would need
    // its own notification channel for that. If the IPC fails, the default (hide) applies.
    const raw = await window.claudeswitcher.settings().catch((error: unknown) => {
      console.error('[overlay] could not read the settings', error)
      return undefined
    })
    const { hideAfterLastDecision } = readOverlaySettings(raw)
    const next = nextAfterDecision(latest.current.rows, latest.current.decisions, decided, hideAfterLastDecision)
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

  // Scrolls the selected row into view. The list scrolls, so without this the arrows could move
  // the selection out of the visible area, and Enter would activate a session the user cannot
  // even see. That is the worst kind of bug in this app, because it "works" just the same, it
  // just does not do what you expected.
  const selectedRow = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // No dependency list: the row list is a new array on every render, so the handler would be
  // replaced on every render anyway, and this way it surely sees the freshest rows.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // In a text field the typing belongs to the field: neither the arrows nor Enter nor Esc
      // control the list.
      if (isTypingTarget(event.target)) return
      // On a focused button or <summary>, Enter belongs to the element (presses or opens it), not a jump.
      if (event.key === 'Enter' && isActivationTarget(event.target)) return
      if (event.key === 'Escape') void window.claudeswitcher.hide()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Without this the arrow would also scroll the list besides moving the selection.
        event.preventDefault()
        setSelectedId(moveSelection(ids, selectedId, event.key === 'ArrowDown' ? 1 : -1))
      }
      // With the decision panel open, Tab moves between the buttons there, not a jump.
      if (event.key === 'Enter' || (event.key === 'Tab' && decision === undefined)) {
        event.preventDefault()
        const id = ids[resolveSelectedIndex(ids, selectedId)]
        if (id !== undefined) void window.claudeswitcher.focusSession(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  })

  return (
    <div className="overlay">
      <ul className="sessions">
        {rows.length === 0 && (
          // "No session" and "the daemon cannot be reached" are not the same: the user has to see
          // which one it is.
          <li className="empty">
            {connected ? 'Nincs futó session' : 'Nincs kapcsolat a daemonnal…'}
          </li>
        )}
        {rows.map((row, index) => {
          const pending = activeDecision(row.decisions)
          // The row of a session the snapshot does not know yet: the pending request holds it, so it is waiting.
          const marker = statusMarker(row.session ?? { status: row.status }, row.decisions)
          const badge = pendingBadge(row.decisions)
          return (
            <li
              key={row.sessionId}
              ref={index === selected ? selectedRow : null}
              className={`session ${row.status} ${index === selected ? 'selected' : ''}`}
              onClick={() => {
                setSelectedId(row.sessionId)
              }}
              onDoubleClick={() => {
                void window.claudeswitcher.focusSession(row.sessionId)
              }}
            >
              <span className={`marker tone-${marker.tone}`} title={marker.title}>
                {marker.glyph}
              </span>
              <span className="name">
                {/* Only the text is truncated (…), never the dot: it must show with a long name too. */}
                <span className="name-text" title={row.name}>
                  {row.name}
                </span>
                {row.session !== undefined && hasRemoteControl(row.session) && (
                  <span className="remote" title="Remote Control: telefonról is elérhető">
                    ●
                  </span>
                )}
                {badge !== undefined && (
                  <span className="pending-count" title="Ennyi kérése vár az appban">
                    {badge}
                  </span>
                )}
              </span>
              <span
                className="summary"
                // A pending decision overrides the row; the tooltip still lists every active subagent.
                title={row.session === undefined ? undefined : subagentTooltip(row.session.subagents)}
              >
                {pending !== undefined
                  ? pendingRowText(pending)
                  : row.session !== undefined
                    ? summarize(row.session)
                    : ''}
              </span>
              <span className="age">
                {row.waitingSince !== undefined ? formatDuration(now - row.waitingSince) : ''}
              </span>
            </li>
          )
        })}
      </ul>

      {decision !== undefined && selectedRowView !== undefined && (
        // A boundary of its own, keyed by the request id: a faulty request takes down only its own
        // panel, the list and the other requests keep working. Another request gets a new boundary.
        <ErrorBoundary
          key={decision.id}
          label="decision panel"
          fallback={() => <JumpNotice text="A kérés nem jeleníthető meg" sessionId={selectedRowView.sessionId} />}
        >
          <DecisionPanel
            decision={decision}
            agentLabel={subagentLabel(decision, selectedRowView.session?.subagents)}
            remoteControl={selectedRowView.session !== undefined && hasRemoteControl(selectedRowView.session)}
            keyHistory={keyHistory}
            onDecided={() => {
              afterDecision(decision).catch((error: unknown) => {
                console.error('[overlay] could not move on after the decision', error)
              })
            }}
            onJump={() => {
              // By the session id. For an unknown session the main process finds no window and does
              // not jump. The native prompt is still there in VS Code.
              void window.claudeswitcher.focusSession(selectedRowView.sessionId)
            }}
          />
        </ErrorBoundary>
      )}

      {decision === undefined && selectedRowView !== undefined && waitsOutsideApp(selectedRowView) && (
        // No held request, so nothing to decide, but the row must not be a dead end: the native
        // prompt is there in VS Code.
        <JumpNotice
          text="A VSCode-ban vár jóváhagyásra. Az appból ezt nem lehet eldönteni (az app újraindult, vagy a kérés nem hozzá érkezett)."
          sessionId={selectedRowView.sessionId}
        />
      )}

      <div className="status-bar">
        {/*
          The time of the heartbeat. It is the only sign that the list is ALIVE and just has no
          change. The daemon does not resend an identical snapshot, so on an idle machine a still
          list and a stopped poll would otherwise look exactly the same.
        */}
        <span className="muted">
          {checkedAt === undefined
            ? 'ellenőrizve: még nem'
            : `ellenőrizve: ${formatDuration(now - checkedAt)}`}
        </span>
        {!connected && <span className="muted">kapcsolat megszakadt, újracsatlakozás…</span>}
      </div>
    </div>
  )
}
