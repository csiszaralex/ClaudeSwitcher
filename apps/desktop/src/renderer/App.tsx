import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useRef, useState, type JSX } from 'react'
import { DecisionPanel } from './DecisionPanel.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { isActivationTarget, isTypingTarget, readOverlaySettings } from './decision-actions.js'
import { formatDuration, pendingRowText, subagentLabel, subagentTooltip, summarize } from './format.js'
import { armUntil, type KeyHistory } from './key-guard.js'
import { activeDecision, buildRows, pendingBadge, waitsOutsideApp } from './rows.js'
import { moveSelection, nextAfterDecision, resolveSelectedIndex, selectOnShow, trackArrivals } from './selection.js'
import { hasRemoteControl, statusMarker } from './session-marker.js'
import type { OverlayState } from './useDaemonState.js'
import './styles.css'

/**
 * A panel helye, amikor az appból nem lehet dönteni: egy sor magyarázat és az ugrás a VSCode-ba,
 * hogy a sor ne legyen zsákutca.
 */
function JumpNotice({ text, sessionId }: { text: string; sessionId: string }): JSX.Element {
  return (
    <section className="decision">
      <div className="decision-actions">
        <div className="decision-row">
          <span className="muted">{text}</span>
          <button
            type="button"
            onClick={() => {
              void window.claudeswitcher.focusSession(sessionId)
            }}
          >
            Ugrás a VSCode-ba
          </button>
        </div>
      </div>
    </section>
  )
}

/**
 * @param overlay A daemon élő állapota. Kívülről jön (`main.tsx` `Root`), nem itt olvassuk: így
 * egy renderelési hiba után is él a kapcsolat, és a következő állapot visszaállíthatja a felületet.
 */
export function App({ overlay }: { overlay: OverlayState }): JSX.Element {
  const { sessions, connected, checkedAt, decisions } = overlay
  // Session-azonosító, nem index: a lista átrendeződésekor a kiválasztás a sessionnel
  // együtt mozog. Lásd a selection.ts dokumentációját.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())

  // A sorok: a sessionök, és külön sorként azok a függő kérések, amelyek sessionjét a
  // pillanatkép még nem ismeri (rows.ts). Minden kijelölés és léptetés ezen a listán megy.
  const rows = buildRows(sessions, decisions)
  const ids = rows.map((row) => row.sessionId)
  const selected = resolveSelectedIndex(ids, selectedId)
  const selectedRowView = selected === -1 ? undefined : rows[selected]

  // A panel a legrégebbi, appból még dönthető kérést mutatja; az állapotjelnek mind kell.
  const decision = selectedRowView === undefined ? undefined : activeDecision(selectedRowView.decisions)

  // A legutóbbi állapot az aszinkron kezelőknek (megjelenés, döntés utáni léptetés). Egy
  // renderkori closure a döntés válaszáig vagy a megjelenésig elavulhat — a lépést a
  // legfrissebb listán kell kiszámolni, különben egy közben eltűnt sessionre ugorhatna.
  const latest = useRef({ rows, decisions })
  useEffect(() => {
    latest.current = { rows, decisions }
  })

  // A panel betűjeleinek őréhez (key-guard.ts): mikor jelent meg az overlay, és mikor gépeltünk
  // utoljára szövegmezőbe.
  const keyHistory = useRef<KeyHistory>({ shownArmedAt: 0, lastTypedAt: undefined })
  // Csak újrarenderelést vált ki megjelenéskor: a panel ebből tompítja az engedélyező gombokat.
  const [, rerenderOnShow] = useState(0)

  // Új, appból eldönthető kérésnél a kijelölés rá ugrik, ha a kijelölt sornál nincs döntés, és a
  // felhasználó nem gépel (selection.ts `selectOnArrival`). Csak akkor fut, ha a kérések listája
  // változott; az előző állapot kéréseit a `trackArrivals` tartja.
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

  // Megjelenéskor a legrégebben várakozó sessionre ugrunk, és a panel újra élesedik: az első
  // leütés még a régi kijelölésre mehetne. A jel a main `show` eseménye (az indoklás a main
  // createOverlay-ében).
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

  // Minden szövegmezős leütés ideje, a capture fázisban: akkor is megvan, ha a mező a következő
  // pillanatban eltűnik (a kérés máshol lezárult), és a fókusz a body-ra esik.
  useEffect(() => {
    function onTyped(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) keyHistory.current.lastTypedAt = Date.now()
    }
    window.addEventListener('keydown', onTyped, true)
    return () => {
      window.removeEventListener('keydown', onTyped, true)
    }
  }, [])

  /** Egy appból hozott SIKERES döntés után: a következő várakozóra lép, vagy elrejtőzik. */
  async function afterDecision(decided: PendingDecisionView): Promise<void> {
    // Minden döntésnél frissen kérdezzük: a tálcapipa bármikor átállhat, és egy gyorsítótár
    // ehhez külön értesítési csatornát kívánna. Ha az IPC elbukik, az alapérték (elrejtés) jön.
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

  // A kijelölt sor legördítése. A lista scrollozható, tehát nélküle a nyilakkal a
  // kijelölés kifuthat a látható területről, és az Enter egy olyan sessiont aktiválna,
  // amit a felhasználó nem is lát — a legrosszabb fajta hiba ebben az appban, mert
  // ugyanúgy „működik", csak nem azt teszi, amit vártál.
  const selectedRow = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Függőséglista nélkül: a sorlista minden renderben új tömb, a kezelő tehát úgyis minden
  // renderben cserélődne — így legalább biztosan a legfrissebb sorokat látja.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // Szövegmezőben a gépelés az övé: se a nyilak, se az Enter, se az Esc ne vezérelje a listát.
      if (isTypingTarget(event.target)) return
      // Egy fókuszált gombon vagy <summary>-n az Enter az elemé (megnyomja, nyitja), nem ugrás.
      if (event.key === 'Enter' && isActivationTarget(event.target)) return
      if (event.key === 'Escape') void window.claudeswitcher.hide()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Enélkül a nyíl a listát is elscrollozná a kijelölés mozgatása mellett.
        event.preventDefault()
        setSelectedId(moveSelection(ids, selectedId, event.key === 'ArrowDown' ? 1 : -1))
      }
      // Nyitott döntési panelnél a Tab a gombok között lép — ott nem ugrás.
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
          // „Nincs session" és „nem érjük el a daemont" nem ugyanaz — a felhasználónak
          // látnia kell, melyikről van szó.
          <li className="empty">
            {connected ? 'Nincs futó session' : 'Nincs kapcsolat a daemonnal…'}
          </li>
        )}
        {rows.map((row, index) => {
          const pending = activeDecision(row.decisions)
          // A pillanatképből még ismeretlen session sora: a függő kérés tartja, tehát várakozó.
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
                {/* Csak a szöveg csonkolódik (…), a pötty soha: hosszú névnél is látszania kell. */}
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
                // A függő döntés felülírja a sort; a tooltip addig is az összes aktív subagentet sorolja.
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
        // Saját határ, a kérés azonosítójával kulcsolva: egy hibás kérés csak a saját panelját viszi
        // el, a lista és a többi kérés működik tovább. Egy másik kérés új határt kap.
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
              // A session-azonosítóval, mint eddig. Ismeretlen sessionnél a main nem talál ablakot,
              // és nem ugrik — a natív prompt a VSCode-ban attól még ott van.
              void window.claudeswitcher.focusSession(selectedRowView.sessionId)
            }}
          />
        </ErrorBoundary>
      )}

      {decision === undefined && selectedRowView !== undefined && waitsOutsideApp(selectedRowView) && (
        // Nincs tartott kérés, tehát nincs mit eldönteni — de a sor ne legyen zsákutca: a natív
        // prompt a VSCode-ban ott van.
        <JumpNotice
          text="A VSCode-ban vár jóváhagyásra — az appból ezt nem lehet eldönteni (az app újraindult, vagy a kérés nem hozzá érkezett)."
          sessionId={selectedRowView.sessionId}
        />
      )}

      <div className="status-bar">
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
