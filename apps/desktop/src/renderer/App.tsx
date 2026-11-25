import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { Fragment, useEffect, useRef, useState, type JSX } from 'react'
import {
  AUTO_ACCEPT_HOLD_MS,
  autoTagText,
  autoTagTitle,
  endsHold,
  holdText,
  isAutoAcceptKey,
  type AutoAcceptHold,
} from './auto-accept-hold.js'
import { DecisionPanel } from './DecisionPanel.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { JumpButton } from './JumpButton.js'
import { PeekPanel } from './PeekPanel.js'
import type { QuestionFocus } from './QuestionForm.js'
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
import {
  dueMarkOf,
  EXCLUDED_GROUP_ID,
  EXCLUDED_TEXT,
  exclusionTags,
  groupArrow,
  isClearFinishKey,
  isExcludeKey,
  isTimedExcludeKey,
  keptRows,
  listView,
  selectionAfterChange,
  showsFinishMark,
  type ExclusionState,
  type RowPlace,
} from './list-cleanup.js'
import { isPeekKey, PEEK_TEXT, peekRequest, peekScrollTop } from './peek.js'
import { activeDecision, buildRows, panelRequest, pendingBadge, rowFolder, waitsOutsideApp } from './rows.js'
import { pendingRowText } from '../shared/row-text.js'
import { requestSource, type RequestSource, type SessionHost } from '../shared/request-source.js'
import { moveSelection, nextAfterDecision, resolveSelectedIndex, selectOnShow, trackArrivals } from './selection.js'
import { isSearchChord, isSearchKey, SEARCH_KEYS_LABEL } from './session-search.js'
import { hasRemoteControl, outsideAppMessage } from './session-marker.js'
import { SourceLabel } from './SourceLabel.js'
import { UntilBar } from './UntilBar.js'
import { sessionUsageLimit, usageLimitStatusText } from './usage-limit.js'
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
 * @param trackSeen Takes the reply of a request that answers with the seen finishes (a cleared ✓), so
 * the list redraws at once (`useSeenFinishes`).
 * @param exclusion The sessions moved out of the list, and the ones that came back because they
 * started running or because their time passed (`useExcludedSessions`), for the excluded group,
 * the rows' tags and the time bar.
 * @param trackExcluded Takes the reply of a Delete, of a time from the bar or of a Backspace on a
 * due row, which answer with the excluded sessions, and calls `onApplied` with them in the same
 * update (`useExcludedSessions`).
 * @param autoAccept The sessions in the auto-accept mode and their counts (`useAutoAccept`).
 * @param trackAutoAccept Takes the reply of a completed Shift+A hold, which answers with them (`useAutoAccept`).
 */
export function App({
  overlay,
  seenFinishes,
  trackSeen,
  exclusion,
  trackExcluded,
  autoAccept,
  trackAutoAccept,
}: {
  overlay: OverlayState
  seenFinishes: SeenFinishes
  trackSeen: (reply: Promise<unknown>) => void
  exclusion: ExclusionState
  trackExcluded: (reply: Promise<unknown>, onApplied?: (exclusion: ExclusionState) => void) => void
  autoAccept: ReadonlyMap<string, number>
  trackAutoAccept: (reply: Promise<unknown>) => void
}): JSX.Element {
  const { sessions, connected, checkedAt, decisions } = overlay
  const excluded = exclusion.excluded
  // A session id, not an index: when the list reorders, the selection moves with the session.
  // See the selection.ts documentation.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())
  const appVersion = useAppVersion()
  // The search (Ctrl+K, session-search.ts): `undefined` while it is closed, else the query typed.
  const [query, setQuery] = useState<string | undefined>()
  const searchField = useRef<HTMLInputElement | null>(null)
  // The peek (Space, peek.ts): the session whose conversation shows in place of the list, else
  // `undefined`. Its history's scroll box, which the keys scroll.
  const [peekId, setPeekId] = useState<string | undefined>()
  const peekHistory = useRef<HTMLDivElement | null>(null)
  // Whether the excluded group at the bottom of the list shows its rows (list-cleanup.ts).
  const [groupOpen, setGroupOpen] = useState(false)
  // The running Shift+A hold on the selected row (auto-accept-hold.ts), else `undefined`; and a
  // counter that redraws its countdown while it runs.
  const [hold, setHold] = useState<AutoAcceptHold | undefined>()
  const [, redrawHold] = useState(0)
  // The session whose time bar shows under its row (Shift+Delete, `UntilBar`), else `undefined`.
  const [untilBarId, setUntilBarId] = useState<string | undefined>()

  // All rows: the sessions, plus a row of its own for each pending request whose session the
  // snapshot does not know yet, in the list's order (rows.ts).
  const allRows = buildRows(sessions, decisions, seenFinishes)
  // What the list shows (list-cleanup.ts `listView`): the rows not in the excluded group, or while
  // the search is open its matches among them and then its matches in the group, in the same order;
  // then, while the search is closed, the group's header and, while it is open, its rows. The
  // selection and the stepping work on its items (`ids`).
  const list = listView(allRows, excluded, query, groupOpen)
  const rows = list.rows
  const ids = list.ids
  const selected = resolveSelectedIndex(ids, selectedId)
  const selectedItem = selected === -1 ? undefined : ids[selected]
  const headerSelected = selectedItem === EXCLUDED_GROUP_ID
  /** Whether the item is a row of the open excluded group. */
  const inGroup = (id: string | undefined): boolean => list.group.some((row) => row.sessionId === id) && list.groupOpen
  const selectedRowView =
    selectedItem === undefined || headerSelected
      ? undefined
      : [...rows, ...list.excludedMatches, ...list.group].find((row) => row.sessionId === selectedItem)
  // The peeked row, among all rows: the search does not hide it. Only a row with a session has a
  // conversation; a row that only holds requests opens nothing.
  const peekRow = peekId === undefined ? undefined : allRows.find((row) => row.sessionId === peekId && row.session !== undefined)

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
  // meanwhile. `rows` holds all rows above the excluded group, not only the search's matches: the
  // search and the group close on show, and a row in the group waits for nothing (list-cleanup.ts
  // `inExcludedGroup`), so neither the show nor the step after a decision selects one. `allRows`,
  // `excluded`, `ids`, `query` and `groupOpen` are for the search's first match (`onQuery`) and the
  // selection after a Delete's reply (`setExcluded`).
  const latest = useRef({ rows: keptRows(allRows, excluded), decisions, allRows, excluded, ids, query, groupOpen })
  useEffect(() => {
    latest.current = { rows: keptRows(allRows, excluded), decisions, allRows, excluded, ids, query, groupOpen }
  })

  // For the guard on the panel's key letters (key-guard.ts): when the overlay appeared, and when
  // the user last typed into a text field.
  const keyHistory = useRef<KeyHistory>({ shownArmedAt: 0, lastTypedAt: undefined })
  // The question form's focus while one shows (`QuestionForm`): Tab enters it, a show leaves it.
  const questionFocus = useRef<QuestionFocus | null>(null)
  // Only triggers a re-render on show: from it the panel dims the allowing buttons.
  const [, rerenderOnShow] = useState(0)

  // On a new request the app can decide, the selection jumps to it if the selected row has no
  // decision and the user is not typing (selection.ts `selectOnArrival`). Runs only when the list
  // of requests changed; `trackArrivals` keeps the requests of the previous state.
  const arrivals = useRef(trackArrivals())
  useEffect(() => {
    const next = arrivals.current({
      sessions: keptRows(allRows, excluded),
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
        // The keys act on the list again on every show, not on a question form left focused.
        questionFocus.current?.leave()
        // The search, the peek, the excluded group and the time bar start closed on every show, and
        // no hold runs.
        setHold(undefined)
        setQuery(undefined)
        setPeekId(undefined)
        setGroupOpen(false)
        setUntilBarId(undefined)
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
  // The list comes back after the peek, so the closing scrolls too.
  const selectedRow = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' })
  }, [selected, peekId])

  // The time bar belongs to the selected row: it closes when the selection leaves that row (a click
  // on another row, the row gone).
  const untilBarOff = untilBarId !== undefined && untilBarId !== selectedItem
  useEffect(() => {
    if (untilBarOff) setUntilBarId(undefined)
  }, [untilBarOff])

  // A session that went away while its peek was open: back to the list.
  const peekGone = peekId !== undefined && peekRow === undefined
  useEffect(() => {
    if (peekGone) setPeekId(undefined)
  }, [peekGone])

  // A running hold ends early, changing nothing, when the A or the Shift is released, the window
  // loses the focus, the selection leaves its row, or the peek opens. Otherwise it completes after
  // `AUTO_ACCEPT_HOLD_MS` from its first keydown (the key's auto-repeat does not restart it), and the
  // main process turns the mode on or off (`AutoAccept.set`).
  const holdOff = hold !== undefined && (hold.sessionId !== selectedItem || peekId !== undefined)
  useEffect(() => {
    if (holdOff) setHold(undefined)
  }, [holdOff])
  useEffect(() => {
    if (hold === undefined) return
    const cancel = (): void => {
      setHold(undefined)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (endsHold(event)) cancel()
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', cancel)
    const done = setTimeout(() => {
      setHold(undefined)
      trackAutoAccept(window.claudeswitcher.setAutoAccept(hold.sessionId, hold.turnOn))
    }, Math.max(0, hold.startedAt + AUTO_ACCEPT_HOLD_MS - Date.now()))
    const countdown = setInterval(() => {
      redrawHold((count) => count + 1)
    }, 200)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', cancel)
      clearTimeout(done)
      clearInterval(countdown)
    }
  }, [hold])

  // The Esc that hides the overlay hides it on its release, not on its press. Hiding gives the focus
  // back to the window in front before (`main/focus-return.ts`), and with the key still down that
  // window would get its release, and its auto-repeat if held: a browser showing a video full screen
  // took that as its own Esc and left full screen (seen by the owner, 2026-11-22). A press the overlay
  // armed only counts: an Esc that went down elsewhere does nothing here, and the focus leaving the
  // overlay meanwhile disarms it.
  const escapeHides = useRef(false)
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !escapeHides.current) return
      escapeHides.current = false
      event.preventDefault()
      void window.claudeswitcher.hide()
    }
    const disarm = (): void => {
      escapeHides.current = false
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', disarm)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', disarm)
    }
  }, [])

  /** Back from the peek to the list, with the peeked session selected (a new request may have moved the selection meanwhile). */
  function closePeek(id: string): void {
    setSelectedId(id)
    setPeekId(undefined)
  }

  /**
   * The keys while the peek is open: Space or Esc goes back to the list, Enter jumps to the session
   * as on its row, the arrows, PageUp/PageDown and Home/End scroll the history. Every other key does
   * nothing; the decision panel is not drawn meanwhile, so its key letters do nothing either.
   */
  function onPeekKey(event: KeyboardEvent, id: string): void {
    if (isPeekKey(event) || event.key === 'Escape') {
      event.preventDefault()
      closePeek(id)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void window.claudeswitcher.focusSession(id)
      return
    }
    const box = peekHistory.current
    const top = box === null ? undefined : peekScrollTop(event.key, box)
    if (box !== null && top !== undefined) {
      event.preventDefault()
      box.scrollTop = top
    }
  }

  /**
   * Typing in the search: the list shows the matches, and the first match is selected, an excluded
   * one only when no other session matches (list-cleanup.ts `listView`).
   */
  function onQuery(next: string): void {
    setQuery(next)
    const { allRows: rowsNow, excluded: excludedNow } = latest.current
    const first = listView(rowsNow, excludedNow, next, false).ids[0]
    if (next.trim() !== '' && first !== undefined) setSelectedId(first)
  }

  /**
   * Moves the session out of the list (`exclude`) or brings it back, by Delete. The direction is
   * explicit, so a second Delete before the reply asks the same again, which the main process
   * ignores. When the reply has moved the selected row out of the list's items, the selection goes
   * to its neighbour (list-cleanup.ts `selectionAfterChange`), in the same update as the list.
   */
  function setExcluded(sessionId: string, exclude: boolean): void {
    applyExclusion(sessionId, window.claudeswitcher.setExcluded(sessionId, exclude))
  }

  /**
   * Excludes the session until `until`, or gives an excluded one a new time: the time bar's
   * confirmation. The bar closes; the selection follows the reply as after a Delete.
   */
  function excludeUntil(sessionId: string, until: number): void {
    setUntilBarId(undefined)
    applyExclusion(sessionId, window.claudeswitcher.setExcludedUntil(sessionId, until))
  }

  /** Takes a reply that may move the session's row, with the selection after it (`selectionAfterChange`). */
  function applyExclusion(sessionId: string, reply: Promise<unknown>): void {
    trackExcluded(reply, (next) => {
      const { allRows: rowsNow, ids: before, query: queryNow, groupOpen: openNow } = latest.current
      const after = listView(rowsNow, next.excluded, queryNow, openNow).ids
      setSelectedId((current) => selectionAfterChange(before, after, current, sessionId))
    })
  }

  /** Closes the time bar without a change (Esc in it, the focus leaving it, the window losing the focus). */
  function closeUntilBar(): void {
    setUntilBarId(undefined)
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
      if (peekRow !== undefined) {
        onPeekKey(event, peekRow.sessionId)
        return
      }
      const inSearch = searchField.current !== null && event.target === searchField.current
      // Ctrl+K opens the search, also from the search field itself (the focus stays there), but not
      // from another text field, whose keys are its own.
      if (isSearchChord(event)) {
        if (isTypingTarget(event.target) && !inSearch) return
        event.preventDefault()
        openSearch()
        return
      }
      // A plain `/` opens it too, but only outside every text field, the search field included,
      // where it is just a character of the query.
      if (isSearchKey(event) && !isTypingTarget(event.target)) {
        event.preventDefault()
        openSearch()
        return
      }
      // In another text field the typing belongs to the field: neither the arrows nor Enter nor
      // Esc control the list. In the search field only the arrows, Enter and Esc do; the rest is
      // the query (the panel's key letters skip a text field too, `isTypingTarget`).
      if (isTypingTarget(event.target) && !inSearch) return
      if (inSearch && !SEARCH_FIELD_KEYS.has(event.key)) return
      // Shift+A starts the hold that turns the selected row's auto-accept mode on or off
      // (auto-accept-hold.ts). Only its first keydown starts it: the auto-repeat of the held key
      // does not restart the countdown. The decision panel's letters skip it (Shift, key-guard.ts).
      if (isAutoAcceptKey(event)) {
        event.preventDefault()
        const row = selectedRowView
        if (!event.repeat && row !== undefined) {
          const start: AutoAcceptHold = { sessionId: row.sessionId, turnOn: !autoAccept.has(row.sessionId), startedAt: Date.now() }
          setHold((current) => current ?? start)
        }
        return
      }
      // Space opens the peek of the selected session, also on a focused button or <summary>, which
      // it must not press: its default is prevented, the focus leaves the element, and the panel
      // with its buttons is not drawn while the peek is open. A text field keeps its Space (the
      // returns above).
      if (isPeekKey(event)) {
        event.preventDefault()
        const row = selectedRowView
        if (row?.session !== undefined) {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          setPeekId(row.sessionId)
        }
        return
      }
      // Backspace clears the selected row's ✓ and its `teendő` mark (list-cleanup.ts), each where
      // there is one. Its default is prevented, so a focused button is not pressed (Chromium presses
      // a button only on Enter and Space anyway). The main process checks the session's state when
      // the request arrives (`clearFinish`), so a row whose session started a new turn meanwhile
      // keeps its ✓.
      if (isClearFinishKey(event)) {
        event.preventDefault()
        const row = selectedRowView
        if (row !== undefined && showsFinishMark(row)) trackSeen(window.claudeswitcher.clearFinish(row.sessionId))
        if (row !== undefined && dueMarkOf(row, exclusion) !== undefined) trackExcluded(window.claudeswitcher.clearDue(row.sessionId))
        return
      }
      // Shift+Delete opens the time bar under the selected row (`UntilBar`), which excludes its
      // session until a time, or gives an excluded one a new time. It never excludes by itself. A row
      // without a session and the group's header do nothing. In the search field it never gets here
      // (the returns above): there it edits the text.
      if (isTimedExcludeKey(event)) {
        event.preventDefault()
        const row = selectedRowView
        if (row?.session !== undefined) {
          // An Esc pressed before, still down, must not hide the overlay on its release in the bar.
          escapeHides.current = false
          setUntilBarId(row.sessionId)
        }
        return
      }
      // Delete moves the selected row's session into the excluded group, or an excluded one back
      // (list-cleanup.ts). A row without a session and the group's header do nothing. As with
      // Backspace, the main process checks the session's state when the request arrives.
      if (isExcludeKey(event)) {
        event.preventDefault()
        const row = selectedRowView
        if (row?.session !== undefined) setExcluded(row.sessionId, !excluded.has(row.sessionId))
        return
      }
      // On a focused button or <summary>, Enter belongs to the element (presses or opens it), not a jump.
      if (event.key === 'Enter' && isActivationTarget(event.target)) return
      if (event.key === 'Escape') {
        // The first Esc closes the search, with the full list back and the selection kept. Without a
        // search the Esc hides the overlay, but only on its release (`escapeHides`).
        if (query === undefined) {
          event.preventDefault()
          if (!event.repeat) escapeHides.current = true
        } else setQuery(undefined)
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Without this the arrow would also scroll the list besides moving the selection.
        event.preventDefault()
        setSelectedId(moveSelection(ids, selectedId, event.key === 'ArrowDown' ? 1 : -1))
      }
      // ←/→ on the excluded group, as in a tree view (`groupArrow`). Not in the search field, whose
      // arrows move the cursor (`SEARCH_FIELD_KEYS` returned above), and not in a question form,
      // which keeps its own keys.
      const arrow = groupArrow(event, headerSelected ? 'header' : inGroup(selectedItem) ? 'group-row' : 'other', list.groupOpen)
      if (arrow !== undefined) {
        event.preventDefault()
        if (arrow === 'open') setGroupOpen(true)
        else if (arrow === 'close') setGroupOpen(false)
        else setSelectedId(EXCLUDED_GROUP_ID)
        return
      }
      // With a question form open, Tab moves the focus onto its active question; from then on its
      // keys are the form's own (`QuestionForm` `onKeyDown`), and the list's keys rest until Esc.
      // With another decision panel open, Tab moves between the buttons there, not a jump.
      if (event.key === 'Tab' && panel !== undefined) {
        const form = questionFocus.current
        if (form !== null) {
          event.preventDefault()
          form.enter()
        }
        return
      }
      // In the search, Enter opens the selected match; without a match there is nothing to open. On
      // the excluded group's header Enter opens or closes the group, and Tab does nothing.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        if (headerSelected) {
          if (event.key === 'Enter') setGroupOpen((open) => !open)
          return
        }
        if (selectedItem !== undefined) void window.claudeswitcher.focusSession(selectedItem)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  })

  /**
   * One row of the list, at its `place`: above the excluded group, among the search's matches in the
   * group, or in the open group. The last two are dimmed. The tags of its exclusion
   * (list-cleanup.ts `exclusionTags`) follow its name.
   */
  function renderRow(row: (typeof allRows)[number], place: RowPlace): JSX.Element {
    const pending = activeDecision(row.decisions)
    const marker = row.marker
    const badge = pendingBadge(row.decisions)
    // The source tag shows only on a row with a request and only when it stands out (shared/request-source.ts).
    const source = requestSource(row.session?.entrypoint)
    const flagged = source.standsOut && row.decisions.length > 0
    const note = promptedByNote(row.promptedBy)
    const isSelected = !headerSelected && row.sessionId === selectedItem
    // In the auto-accept mode: the green row and the `auto` tag with the mode's count.
    const autoAllowed = autoAccept.get(row.sessionId)
    const rowHold = hold?.sessionId === row.sessionId ? hold : undefined
    const session = row.session
    return (
      <Fragment key={row.sessionId}>
        <li
          ref={isSelected ? selectedRow : null}
          className={`session ${row.status} ${place === 'list' ? '' : 'excluded'} ${isSelected ? 'selected' : ''} ${autoAllowed === undefined ? '' : 'auto-accept'}`}
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
            {autoAllowed !== undefined && (
              <span className="auto-tag" title={autoTagTitle(autoAllowed)}>
                {autoTagText(autoAllowed)}
              </span>
            )}
            {exclusionTags(row, place, exclusion, now).map((tag) => (
              <span key={tag.text} className="excluded-tag" title={tag.title}>
                {tag.text}
              </span>
            ))}
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
            {/* A running Shift+A hold's countdown takes the place of the row's text. */}
            {rowHold !== undefined ? (
              <span className="auto-hold">{holdText(rowHold, Date.now())}</span>
            ) : pending !== undefined ? (
              pendingRowText(pending)
            ) : row.waitsOn.length > 0 ? (
              waitsOnText(row.waitsOn)
            ) : row.session !== undefined ? (
              summarize(row.session, now)
            ) : (
              ''
            )}
          </span>
          <span className="age">
            {row.waitingSince !== undefined ? formatDuration(now - row.waitingSince) : ''}
          </span>
        </li>
        {isSelected && untilBarId === row.sessionId && session !== undefined && (
          <UntilBar
            now={now}
            weeklyReset={exclusion.weeklyReset}
            limitResetsAt={sessionUsageLimit(session)?.resetsAt}
            onConfirm={(until) => {
              excludeUntil(row.sessionId, until)
            }}
            onClose={closeUntilBar}
          />
        )}
      </Fragment>
    )
  }

  return (
    <div className="overlay">
      {peekRow !== undefined ? (
        // In place of the list, the search and the panel: their keys rest meanwhile (App's `onKey`).
        <ErrorBoundary
          key={peekRow.sessionId}
          label="peek"
          fallback={() => <p className="empty">{PEEK_TEXT.unreadable}</p>}
        >
          <PeekPanel
            sessionId={peekRow.sessionId}
            name={peekRow.name}
            marker={peekRow.marker}
            folder={rowFolder(peekRow)}
            sessions={sessions}
            scrollRef={peekHistory}
            request={peekRequest(peekRow.decisions)}
          />
        </ErrorBoundary>
      ) : (
        <>
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
            {rows.length === 0 && list.excludedMatches.length === 0 && !list.groupShown && (
              // "No session", "the daemon cannot be reached" and "the search finds none" are not the
              // same: the user has to see which one it is.
              <li className="empty">
                {allRows.length > 0 ? 'Nincs találat' : connected ? 'Nincs futó session' : 'Nincs kapcsolat a daemonnal…'}
              </li>
            )}
            {rows.map((row) => renderRow(row, 'list'))}
            {list.excludedMatches.map((row) => renderRow(row, 'match'))}
            {list.groupShown && (
              <li
                key={EXCLUDED_GROUP_ID}
                ref={headerSelected ? selectedRow : null}
                className={`excluded-header ${headerSelected ? 'selected' : ''}`}
                title={EXCLUDED_TEXT.groupTitle}
                onClick={() => {
                  setSelectedId(EXCLUDED_GROUP_ID)
                  setGroupOpen((open) => !open)
                }}
              >
                <span className="excluded-toggle">{list.groupOpen ? '▾' : '▸'}</span>
                <span>{EXCLUDED_TEXT.group(list.group.length)}</span>
              </li>
            )}
            {list.groupOpen && list.group.map((row) => renderRow(row, 'group'))}
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
                questionFocus={questionFocus}
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
        </>
      )}

      <div className="status-bar">
        {/*
          The selected session's source (as the panel shows it, shared/request-source.ts) and its
          folder, shortened in the middle, the full path in the tooltip. Not while a decision panel
          shows (`panel`): its source line names the source and the request's working folder, and
          the panel's error stand-in (`JumpNotice` with `origin`) the source and this folder. Nor
          while the peek shows: its header names the folder, and the selection may have moved to
          another session meanwhile. It truncates on a narrow window; the right part never does.
        */}
        {selectedRowView !== undefined && panel === undefined && peekRow === undefined && (
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
            The hint of the search's keys (`SEARCH_KEYS_LABEL`), or of the peek's while it shows
            (`PEEK_TEXT.keys`), the account's usage limit while
            one runs (`usageLimitStatusText`), the app's version, then the time of the heartbeat.
            The heartbeat is the only sign that
            the list is ALIVE and just has no change. The daemon does not resend an identical
            snapshot, so on an idle machine a still list and a stopped poll would otherwise look
            exactly the same.
          */}
          {peekRow !== undefined ? (
            <span className="muted">{PEEK_TEXT.keys}</span>
          ) : (
            <span className="muted" title="Session keresése">
              Keresés: {SEARCH_KEYS_LABEL}
            </span>
          )}
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
