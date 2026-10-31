import type { UserDecision } from '@claudeswitcher/core'
import { UNREADABLE_REQUEST } from '@claudeswitcher/core/browser'
import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useMemo, useState, type JSX, type RefObject } from 'react'
import {
  isTypingTarget,
  isUnreadableQuestion,
  readDecideResult,
  shortcutFor,
  type DecisionAction,
} from './decision-actions.js'
import { armUntil, isArmed, shortcutAllowed, type KeyHistory } from './key-guard.js'
import { PlanPanel } from './PlanPanel.js'
import { QuestionForm } from './QuestionForm.js'
import { RuleEditor } from './RuleEditor.js'
import { LINE_MARK, panelContent } from './edit-preview.js'
import { ruleEditorSeed, suggestionTooltip } from './rule-editor.js'
import { releasedMessage } from './session-marker.js'
import { summaryView } from './summary-view.js'
import { DETAILS_LIMIT, sandboxDisabled } from './tool-details.js'

const KIND_LABEL = {
  tool: 'Engedélyt kér',
  edit: 'Fájlt írna',
  question: 'Kérdez',
  plan: 'Tervet hagyatna jóvá',
} as const

type Mode = 'buttons' | 'deny' | 'rule-project' | 'rule-machine'

interface Props {
  decision: PendingDecisionView
  /** A kérő subagent felirata a fejlécben (format.ts `subagentLabel`); a fő sessionnél nincs. */
  agentLabel: string | undefined
  /** Van-e a sessionnek Remote Control kapcsolata (session-marker.ts `hasRemoteControl`): az elengedett kérés szövegét adja. */
  remoteControl: boolean
  /** Az App billentyű-előzménye: az overlay megjelenése és az utolsó szövegmezős leütés (key-guard.ts). */
  keyHistory: RefObject<KeyHistory>
  /** A daemon elfogadta a döntést: az App ebből lépteti a kijelölést, vagy rejti el az overlayt. */
  onDecided: () => void
  /** Ugrás a session VSCode ablakára: ott a natív prompt végig megvan. */
  onJump: () => void
}

/**
 * Egy függő kérés döntési panelje. A döntést a main processzen át a daemon ellenőrzi és
 * továbbítja; siker esetén a következő állapot leveszi a kérést, és a panel eltűnik.
 */
export function DecisionPanel({
  decision,
  agentLabel,
  remoteControl,
  keyHistory,
  onDecided,
  onJump,
}: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('buttons')
  const [denyText, setDenyText] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(choice: UserDecision): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const result = readDecideResult(await window.claudeswitcher.decide(decision.id, choice))
      if (result.ok) onDecided()
      else setError(result.reason)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  function run(action: DecisionAction): void {
    switch (action) {
      case 'allow':
        void submit({ type: 'allow' })
        return
      case 'session-edits':
        void submit({ type: 'allow-session-edits' })
        return
      case 'deny':
      case 'rule-project':
      case 'rule-machine':
        setMode(action)
        return
    }
  }

  // Élesedés: a panel minden kéréshez újra mountol (az App `key={decision.id}`-ja), így ez minden
  // új kérésnél újraindul. Az overlay megjelenése a `keyHistory`-ból élesít újra.
  const [mountArmedAt] = useState(() => armUntil(Date.now()))
  function armedAt(): number {
    return Math.max(mountArmedAt, keyHistory.current.shownArmedAt)
  }
  // Az engedélyező gombok az élesedésig tiltva: egy dupla kattintás második fele ugyanoda esik,
  // és a következő kérés gombját nyomná meg. A tiltás, az ugrás és a mégse gomb élesedés nélkül is megy.
  const armed = isArmed(armedAt(), Date.now())
  const [, rerenderWhenArmed] = useState(0)
  useEffect(() => {
    const wait = armedAt() - Date.now()
    if (wait <= 0) return
    const timer = setTimeout(() => {
      rerenderWhenArmed((count) => count + 1)
    }, wait)
    return () => {
      clearTimeout(timer)
    }
  })

  // A betűjelek. Nyitott űrlapnál, futó kérés közben és elengedett kérésnél nem hatnak; a többi
  // feltétel (ismétlés, módosítók, szövegmező, élesedés, gépelés utáni szünet) a key-guard.ts-ben.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (decision.released || busy || mode !== 'buttons') return
      const key = {
        repeat: event.repeat,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        typingTarget: isTypingTarget(event.target),
      }
      const clock = { armedAt: armedAt(), lastTypedAt: keyHistory.current.lastTypedAt, now: Date.now() }
      if (!shortcutAllowed(key, clock)) return
      const action = shortcutFor(decision.kind, event.key, decision.readable)
      if (action === undefined) return
      event.preventDefault()
      run(action)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  })

  function jumpRow(text: string): JSX.Element {
    return (
      <div className="decision-row">
        <span className="muted">{text}</span>
        <button type="button" onClick={onJump}>
          Ugrás a VSCode-ba
        </button>
      </div>
    )
  }

  function body(): JSX.Element {
    if (decision.released) return jumpRow(`Az app elengedte. ${releasedMessage(remoteControl)}`)

    if (mode === 'deny') {
      return (
        <form
          className="decision-row"
          onSubmit={(event) => {
            event.preventDefault()
            void submit({ type: 'deny', message: denyText })
          }}
        >
          <input
            autoFocus
            className="grow"
            value={denyText}
            placeholder="Indoklás a sessionnek (nem kötelező)"
            onChange={(event) => {
              setDenyText(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setMode('buttons')
              }
            }}
          />
          <button type="submit" disabled={busy}>
            Tilt
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('buttons')
            }}
          >
            Mégse
          </button>
        </form>
      )
    }

    if (mode === 'rule-project' || mode === 'rule-machine') {
      const destination = mode === 'rule-machine' ? 'userSettings' : 'localSettings'
      const seed = ruleEditorSeed(decision.suggestedRules)
      return (
        <RuleEditor
          initial={seed.text}
          multilineSuggestions={seed.multiline}
          machine={mode === 'rule-machine'}
          busy={busy}
          onSubmit={(rules) => {
            void submit({ type: 'allow-with-rules', rules, destination })
          }}
          onCancel={() => {
            setMode('buttons')
          }}
        />
      )
    }

    // Olvashatatlan parancs, fájl vagy URL: engedélyezést a core úgyis elutasítana. A sor ne legyen
    // zsákutca: tiltani lehet, és a natív prompt a VSCode-ban ott van.
    if (!decision.readable) {
      return (
        <div className="decision-row">
          <span className="muted">{UNREADABLE_REQUEST}</span>
          <button type="button" disabled={busy} onClick={() => { run('deny') }}>
            <kbd>D</kbd> Tilt…
          </button>
          <button type="button" onClick={onJump}>
            Ugrás a VSCode-ba
          </button>
        </div>
      )
    }

    switch (decision.kind) {
      case 'tool': {
        // A Claude Code javaslata mindkét szabálygomb szerkesztőjét kitölti, ezért mindkettő jelet
        // kap: a billentyűjel inverz (narancs háttér), így a gombsor egy sorban marad. A szabály a tooltipben.
        const suggestion = suggestionTooltip(decision.suggestedRules)
        const ruleKey = suggestion === undefined ? undefined : 'suggested'
        return (
          <div className="decision-row">
            <button type="button" disabled={busy || !armed} onClick={() => { run('allow') }}>
              <kbd>A</kbd> Engedélyez
            </button>
            <button type="button" disabled={busy} onClick={() => { run('deny') }}>
              <kbd>D</kbd> Tilt…
            </button>
            <button type="button" disabled={busy || !armed} title={suggestion} onClick={() => { run('rule-project') }}>
              <kbd className={ruleKey}>P</kbd> Projekt-szabály…
            </button>
            <button type="button" disabled={busy || !armed} title={suggestion} onClick={() => { run('rule-machine') }}>
              <kbd className={ruleKey}>G</kbd> Gépszintű szabály…
            </button>
          </div>
        )
      }
      case 'edit':
        return (
          <div className="decision-row">
            <button type="button" disabled={busy || !armed} onClick={() => { run('allow') }}>
              <kbd>A</kbd> Engedélyez
            </button>
            <button type="button" disabled={busy} onClick={() => { run('deny') }}>
              <kbd>D</kbd> Tilt…
            </button>
            <button type="button" disabled={busy || !armed} onClick={() => { run('session-edits') }}>
              <kbd>S</kbd> Erre a sessionre automatikusan
            </button>
          </div>
        )
      case 'question':
        // Kiolvashatatlan kérdésre nem lehet válaszolni (a daemon el is utasítaná), de a sor ne
        // legyen zsákutca: a natív prompt a VSCode-ban ott van, vagy a session tiltást kap üzenettel.
        if (isUnreadableQuestion(decision)) {
          return (
            <div className="decision-row">
              <span className="muted">A kérdés formátuma ismeretlen, itt nem válaszolható.</span>
              <button type="button" disabled={busy} onClick={() => { setMode('deny') }}>
                Tilt…
              </button>
              <button type="button" onClick={onJump}>
                Ugrás a VSCode-ba
              </button>
            </div>
          )
        }
        return (
          <QuestionForm
            questions={decision.questions}
            busy={busy}
            onSubmit={(answers) => {
              void submit({ type: 'answer', answers })
            }}
          />
        )
      case 'plan':
        return (
          <PlanPanel
            plan={decision.plan}
            busy={busy}
            onReject={(feedback) => {
              void submit({ type: 'deny', message: feedback })
            }}
            onJump={onJump}
          />
        )
    }
  }

  // Az App másodpercenként újrarenderel (az órák miatt); egy nagy szkript formázása vagy egy
  // fájl soronkénti összevetése ne fusson le minden tikkre.
  const { preview, details } = useMemo(() => panelContent(decision), [decision])
  const summary = useMemo(() => summaryView(decision.summary), [decision])
  const limitNote = (
    <p className="muted">
      Levágva: csak az első {DETAILS_LIMIT.toLocaleString('hu-HU')} karakter látszik. A teljes
      szöveg a VSCode-ban.
    </p>
  )

  // Kérdésnél és tervnél a művelet-terület maga is hosszú (kérdések, tervszöveg): ott a belseje
  // görget, a küldő gombok pedig alul maradnak.
  const fill = decision.kind === 'question' || decision.kind === 'plan'

  // Felül a fejléc, alul a művelet-terület, köztük a görgethető tartalom: egy hosszú parancsnál
  // se kelljen a gombokig görgetni (Task 10, 2. eltérés).
  return (
    <section className="decision">
      <header className="decision-head">
        <span className="decision-kind">{KIND_LABEL[decision.kind]}</span>
        <span className="decision-tool">{decision.toolName}</span>
        {summary.lines > 1 && <span className="decision-lines">{summary.lines.toLocaleString('hu-HU')} sor</span>}
        {agentLabel !== undefined && (
          <span className="decision-agent" title={agentLabel}>
            {agentLabel}
          </span>
        )}
      </header>
      <div className="decision-scroll">
        {sandboxDisabled(decision.toolInput) && (
          <p className="decision-warning">Sandbox nélkül futna (dangerouslyDisableSandbox: true).</p>
        )}
        {/* A leírás a parancs fölött: egy hosszú parancs alatt görgetés nélkül nem látszana. */}
        {decision.description !== undefined && <p className="decision-description">{decision.description}</p>}
        <pre className="decision-summary">
          {summary.segments.map((segment, index) =>
            // A láthatatlan karakter escape-je kiemelve, hogy ne lehessen a parancs részének nézni.
            segment.hidden ? (
              <span key={index} className="invisible-char">
                {segment.text}
              </span>
            ) : (
              segment.text
            ),
          )}
        </pre>
        {summary.truncated && limitNote}
        {preview !== undefined && (
          // Alapból nyitva: ez maga a jóváhagyandó tartalom. Natív <details>, hogy összecsukható legyen.
          <details className="decision-details edit-preview" open>
            <summary>Előnézet</summary>
            {preview.blocks.map((block) => (
              <div key={block.title}>
                <div className="muted">
                  {block.title}
                  {block.notes.length > 0 && ` · ${block.notes.join(' · ')}`}
                </div>
                {block.lines.length > 0 && (
                  <pre>
                    {block.lines.map((line, index) => (
                      // A <pre> tartalma csak szövegszintű elem lehet: blokk-span, nem <div>.
                      // Az előjel egy CSS pszeudo-elem (`data-mark`), nem szöveg: így a kimásolt
                      // sorok pontosan a fájl tartalmát adják, előjel- és szóközoszlop nélkül.
                      <span key={index} className={`diff-line diff-${line.sign}`} data-mark={LINE_MARK[line.sign]}>
                        {line.text}
                      </span>
                    ))}
                  </pre>
                )}
                {block.hiddenLines > 0 && (
                  <p className="muted">… {block.hiddenLines.toLocaleString('hu-HU')} további sor</p>
                )}
              </div>
            ))}
            {preview.truncated && limitNote}
          </details>
        )}
        {details !== undefined && details.blocks.length > 0 && (
          // Natív <details>: billentyűzetről (Tab, Szóköz) saját kód nélkül nyitható.
          <details className="decision-details">
            <summary>Részletek</summary>
            {details.blocks.map((block) => (
              <div key={block.label === undefined ? 'json' : `field:${block.label}`}>
                {block.label !== undefined && <div className="muted">{block.label}</div>}
                <pre>{block.text}</pre>
              </div>
            ))}
            {details.truncated && limitNote}
          </details>
        )}
      </div>
      <div className={fill ? 'decision-actions fill' : 'decision-actions'}>
        {body()}
        {error !== undefined && <p className="decision-error">{error}</p>}
      </div>
    </section>
  )
}
