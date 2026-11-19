import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useRef, useState, type JSX } from 'react'
import { DecisionPanel } from './DecisionPanel.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { JumpButton } from './JumpButton.js'
import { isActivationTarget, isTypingTarget, readOverlaySettings } from './decision-actions.js'
import {
  formatDuration,
  promptedByNote,
  shortenPath,
  subagentLabel,
  subagentTooltip,
  summarize,
  waitsOnText,
} from './format.js'
import { armUntil, type KeyHistory } from './key-guard.js'
import { activeDecision, buildRows, panelRequest, pendingBadge, rowFolder, waitsOutsideApp } from './rows.js'
import { pendingRowText } from '../shared/row-text.js'
import { requestSource, type RequestSource, type SessionHost } from '../shared/request-source.js'
import { moveSelection, nextAfterDecision, resolveSelectedIndex, selectOnShow, trackArrivals } from './selection.js'
import { filterRows, isSearchChord, SEARCH_CHORD_LABEL } from './session-search.js'
import { hasRemoteControl, outsideAppMessage } from './session-marker.js'
import { SourceLabel } from './SourceLabel.js'
import { usageLimitStatusText } from './usage-limit.js'
import { useAppVersion, withAppVersion } from './useAppVersion.js'
import type { OverlayState } from './useDaemonState.js'
import type { SeenFinishes } from '../shared/session-finished.js'
import { nameTooltip } from '../shared/session-name.js'
import './styles.css'

/**
 * Stands in for the panel when the app cannot decide: one line of explanation and the jump to the
 * session's host, so the row is not a dead end. With `origin` it also shows the source line the
 * panel would have (its `decision-source`), for a stand-in while the status bar leaves the source
 * out (App's `panel`).
 */
function JumpNotice({
  text,
  host,
  sessionId,
  origin,
}: {
  text: string
  host: SessionHost
  sessionId: string
  origin?: { source: RequestSource; folder: string | undefined } | undefined
}): JSX.Element {
  return (
    <section className="decision">
      {origin !== undefined && (
        <p className="decision-source">
          <SourceLabel source={origin.source} />
          {origin.folder !== undefined && (
            <span className="muted" title={origin.folder}>
              {origin.folder}
            </span>
          )}
        </p>
      )}
      <div className="decision-actions">
        <div className="decision-row">
          <span className="muted">{text}</span>
          <JumpButton
            host={host}
            onJump={() => {
              void window.claudeswitcher.focusSession(sessionId)
            }}
          />
        </div>
      </div>
    </section>
  )
}

/** The keys of the search field that act on the list (App's `onKey`); every other key is the query's. */
const SEARCH_FIELD_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape'])

/**
 * @param overlay The daemon's live state. It comes from outside (`main.tsx` `Root`) and is not read
 * here: so the connection lives on after a render error, and the next state can restore the UI.
 * @param seenFinishes The finishes the user has seen (`useSeenFinishes`), for the ✓ marker's color.
 */
export function App({ overlay, seenFinishes }: { overlay: OverlayState; seenFinishes: SeenFinishes }): JSX.Element {
  const { sessions, connected, checkedAt, decisions } = overlay
  // A session id, not an index: when the list reorders, the selection moves with the session.
  // See the selection.ts documentation.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())
  const appVersion = useAppVersion()
  // The search (Ctrl+K, session-search.ts): `undefined` while it is closed, else the query typed.
  const [query, setQuery] = useState<string | undefined>()
  const searchField = useRef<HTMLInputElement | null>(null)

  // All rows: the sessions, plus a row of its own for each pending request whose session the
  // snapshot does not know yet, in the list's order (rows.ts).
  const allRows = buildRows(sessions, decisions, seenFinishes)
  // The rows the list shows: all of them, or while the search is open its matches, in the same
  // order. The selection and the stepping work on these.
  const rows = query === undefined ? allRows : filterRows(allRows, query)
  const ids = rows.map((row) => row.sessionId)
  const selected = resolveSelectedIndex(ids, selectedId)
  const selectedRowView = selected === -1 ? undefined : rows[selected]

  // The panel shows the oldest request the app can still decide (rows.ts `panelRequest`); the
  // status marker needs all of them. Computed once: it decides both the panel and the status bar.
  const panel = panelRequest(selectedRowView)
  // The status bar's left part, when no panel names them: where the selected session comes from,
  // and its folder. The source also names the host in the panel's and the notices' texts.
  const selectedSource = requestSource(selectedRowView?.session?.entrypoint)
  const selectedFolder = selectedRowView === undefined ? undefined : rowFolder(selectedRowView)
  // The account's usage limit for the status bar, on the overlay's one-second clock (`now`).
  const limitNote = usageLimitStatusText(sessions, now)

  // The latest state for the async handlers (show, the step after a decision, the search's typing).
  // A closure from render time can go stale before the decision's reply or the show: the step has
  // to be computed on the freshest list, else it could jump to a session that has disappeared
  // meanwhile. All rows, not only the search's matches: the search closes on show.
  const latest = useRef({ rows: allRows, decisions })
  useEffect(() => {
    latest.current = { rows: allRows, decisions }
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
      sessions: allRows,
      decisions,
      selectedId: selectedRowView?.sessionId,
      lastTypedAt: keyHistory.current.lastTypedAt,
      now: Date.now(),
    })
    if (next !== undefined) setSelectedId(next)
  }, [decisions])

  // On show, jump to the session that has been waiting longest (or the one a clicked notification
  // named, `preferred`), and the panel arms again: the
  // first keystroke could still go to the old selection. The signal is the main process's `show` event
  // (the reason is in `createOverlay` in the main process).
  useEffect(
    () =>
      window.claudeswitcher.onShown((preferred) => {
        const armedAt = armUntil(Date.now())
        keyHistory.current.shownArmedAt = armedAt
        rerenderOnShow(armedAt)
        // The search starts closed on every show.
        setQuery(undefined)
        setSelectedId((current) => selectOnShow(latest.current.rows, latest.current.decisions, current, preferred))
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

  /** Typing in the search: the list shows the matches, and the first match is selected. */
  function onQuery(next: string): void {
    setQuery(next)
    const first = filterRows(latest.current.rows, next)[0]
    if (next.trim() !== '' && first !== undefined) setSelectedId(first.sessionId)
  }

  /** Opens the search; when it is open already, puts the focus back into its field. */
  function openSearch(): void {
    if (query === undefined) setQuery('')
    else searchField.current?.focus()
  }

  // No dependency list: the row list is a new array on every render, so the handler would be
  // replaced on every render anyway, and this way it surely sees the freshest rows.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const inSearch = searchField.current !== null && event.target === searchField.current
      // Ctrl+K opens the search, also from the search field itself (the focus stays there), but not
      // from another text field, whose keys are its own.
      if (isSearchChord(event)) {
        if (isTypingTarget(event.target) && !inSearch) return
        event.preventDefault()
        openSearch()
        return
      }
      // In another text field the typing belongs to the field: neither the arrows nor Enter nor
      // Esc control the list. In the search field only the arrows, Enter and Esc do; the rest is
      // the query (the panel's key letters skip a text field too, `isTypingTarget`).
      if (isTypingTarget(event.target) && !inSearch) return
      if (inSearch && !SEARCH_FIELD_KEYS.has(event.key)) return
      // On a focused button or <summary>, Enter belongs to the element (presses or opens it), not a jump.
      if (event.key === 'Enter' && isActivationTarget(event.target)) return
      if (event.key === 'Escape') {
        // The first Esc closes the search, with the full list back and the selection kept.
        if (query === undefined) void window.claudeswitcher.hide()
        else setQuery(undefined)
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Without this the arrow would also scroll the list besides moving the selection.
        event.preventDefault()
        setSelectedId(moveSelection(ids, selectedId, event.key === 'ArrowDown' ? 1 : -1))
      }
      // With the decision panel open, Tab moves between the buttons there, not a jump. In the
      // search, Enter opens the selected match; without a match there is nothing to open.
      if (event.key === 'Enter' || (event.key === 'Tab' && panel === undefined)) {
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
      {query !== undefined && (
        <div className="search">
          {/* Its arrows, Enter and Esc are handled by App's window handler (`onKey`), as the list's. */}
          <input
            ref={searchField}
            className="search-field"
            type="text"
            value={query}
            placeholder="Session keresése…"
            aria-label="Session keresése név vagy mappa szerint"
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              onQuery(event.target.value)
            }}
          />
        </div>
      )}
      <ul className="sessions">
        {rows.length === 0 && (
          // "No session", "the daemon cannot be reached" and "the search finds none" are not the
          // same: the user has to see which one it is.
          <li className="empty">
            {allRows.length > 0 ? 'Nincs találat' : connected ? 'Nincs futó session' : 'Nincs kapcsolat a daemonnal…'}
          </li>
        )}
        {rows.map((row, index) => {
          const pending = activeDecision(row.decisions)
          const marker = row.marker
          const badge = pendingBadge(row.decisions)
          // The source tag shows only on a row with a request and only when it stands out (shared/request-source.ts).
          const source = requestSource(row.session?.entrypoint)
          const flagged = source.standsOut && row.decisions.length > 0
          const note = promptedByNote(row.promptedBy)
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
                {/*
                  Only the text is truncated (…), never the dot: it must show with a long name too.
                  The tooltip also names the registry name when the row shows the tab title.
                */}
                <span className="name-text" title={row.session === undefined ? row.name : nameTooltip(row.session)}>
                  {row.name}
                </span>
                {row.session !== undefined && hasRemoteControl(row.session) && (
                  <span className="remote" title="Remote Control: telefonról is elérhető">
                    ●
                  </span>
                )}
                {flagged && (
                  <span className="source-tag" title={source.title}>
                    {source.label}
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
                {/* The sessions this one works for, first, so the end of a long text is what CSS cuts. */}
                {note !== undefined && (
                  <span className="prompted-by" title={`Megkérte: ${row.promptedBy.join(', ')}`}>
                    {note}{' '}
                  </span>
                )}
                {pending !== undefined
                  ? pendingRowText(pending)
                  : row.waitsOn.length > 0
                    ? waitsOnText(row.waitsOn)
                    : row.session !== undefined
                      ? summarize(row.session, now)
                      : ''}
              </span>
              <span className="age">
                {row.waitingSince !== undefined ? formatDuration(now - row.waitingSince) : ''}
              </span>
            </li>
          )
        })}
      </ul>

      {panel !== undefined && (
        // A boundary of its own, keyed by the request id: a faulty request takes down only its own
        // panel, the list and the other requests keep working. Another request gets a new boundary.
        <ErrorBoundary
          key={panel.decision.id}
          label="decision panel"
          fallback={() => (
            // The status bar leaves the source out while `panel` is defined, so the stand-in names
            // it. The folder is the row's (`rowFolder`): the request that failed to render is not read.
            <JumpNotice
              text="A kérés nem jeleníthető meg."
              host={selectedSource.host}
              sessionId={panel.row.sessionId}
              origin={{ source: selectedSource, folder: selectedFolder }}
            />
          )}
        >
          <DecisionPanel
            decision={panel.decision}
            source={selectedSource}
            agentLabel={subagentLabel(panel.decision, panel.row.session?.subagents)}
            remoteControl={panel.row.session !== undefined && hasRemoteControl(panel.row.session)}
            keyHistory={keyHistory}
            onDecided={() => {
              afterDecision(panel.decision).catch((error: unknown) => {
                console.error('[overlay] could not move on after the decision', error)
              })
            }}
            onJump={() => {
              // By the session id. For an unknown session the main process finds no window and does
              // not jump. The native prompt is still there, in VS Code or in the terminal.
              void window.claudeswitcher.focusSession(panel.row.sessionId)
            }}
          />
        </ErrorBoundary>
      )}

      {panel === undefined && selectedRowView !== undefined && waitsOutsideApp(selectedRowView) && (
        // No held request, so nothing to decide, but the row must not be a dead end: the native
        // prompt is there, in VS Code or in the terminal.
        <JumpNotice
          text={outsideAppMessage(selectedSource.host)}
          host={selectedSource.host}
          sessionId={selectedRowView.sessionId}
        />
      )}

      <div className="status-bar">
        {/*
          The selected session's source (as the panel shows it, shared/request-source.ts) and its
          folder, shortened in the middle, the full path in the tooltip. Not while a decision panel
          shows (`panel`): its source line names the source and the request's working folder, and
          the panel's error stand-in (`JumpNotice` with `origin`) the source and this folder. It
          truncates on a narrow window; the right part never does.
        */}
        {selectedRowView !== undefined && panel === undefined && (
          <span className="status-session">
            <SourceLabel source={selectedSource} />
            {selectedFolder !== undefined && (
              <span className="status-folder" title={selectedFolder}>
                {shortenPath(selectedFolder)}
              </span>
            )}
          </span>
        )}
        <span className="status-checks">
          {/*
            The hint of the search's key (`SEARCH_CHORD_LABEL`), the account's usage limit while
            one runs (`usageLimitStatusText`), the app's version, then the time of the heartbeat.
            The heartbeat is the only sign that
            the list is ALIVE and just has no change. The daemon does not resend an identical
            snapshot, so on an idle machine a still list and a stopped poll would otherwise look
            exactly the same.
          */}
          <span className="muted" title="Session keresése">
            {SEARCH_CHORD_LABEL}: keresés
          </span>
          {limitNote !== undefined && (
            <span className="status-limit" title="Egy munkamenet elérte a használati limitet">
              {limitNote}
            </span>
          )}
          <span className="muted">
            {withAppVersion(
              appVersion,
              checkedAt === undefined ? 'ellenőrizve: még nem' : `ellenőrizve: ${formatDuration(now - checkedAt)}`,
            )}
          </span>
          {!connected && <span className="muted">kapcsolat megszakadt, újracsatlakozás…</span>}
        </span>
      </div>
    </div>
  )
}
