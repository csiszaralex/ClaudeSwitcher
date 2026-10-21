import type { UserDecision } from '@claudeswitcher/core'
import { formatRule } from '@claudeswitcher/core/browser'
import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  isTypingTarget,
  isUnreadableQuestion,
  readDecideResult,
  shortcutFor,
  type DecisionAction,
} from './decision-actions.js'
import { PlanPanel } from './PlanPanel.js'
import { QuestionForm } from './QuestionForm.js'
import { RuleEditor } from './RuleEditor.js'
import { LINE_MARK, panelContent } from './edit-preview.js'
import { DETAILS_LIMIT } from './tool-details.js'

const KIND_LABEL = {
  tool: 'Engedélyt kér',
  edit: 'Fájlt írna',
  question: 'Kérdez',
  plan: 'Tervet hagyatna jóvá',
} as const

type Mode = 'buttons' | 'deny' | 'rule-project' | 'rule-machine'

interface Props {
  decision: PendingDecisionView
  /** A daemon elfogadta a döntést — az App ebből lépteti a kijelölést, vagy rejti el az overlayt. */
  onDecided: () => void
  /** Ugrás a session VSCode ablakára — ott a natív prompt végig megvan. */
  onJump: () => void
}

/**
 * Egy függő kérés döntési panelje. A döntést a main processzen át a daemon ellenőrzi és
 * továbbítja; siker esetén a következő állapot leveszi a kérést, és a panel eltűnik.
 */
export function DecisionPanel({ decision, onDecided, onJump }: Props): JSX.Element {
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

  // A betűjelek. Szövegmezőben, nyitott űrlapnál, futó kérés közben és elengedett kérésnél nem hatnak.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (decision.released || busy || mode !== 'buttons') return
      if (isTypingTarget(event.target) || event.ctrlKey || event.altKey || event.metaKey) return
      const action = shortcutFor(decision.kind, event.key)
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
    if (decision.released) return jumpRow('Az app elengedte — a VSCode-ban vagy a telefonon dönthetsz.')

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
      return (
        <RuleEditor
          initial={decision.suggestedRules.map(formatRule).join('\n')}
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

    switch (decision.kind) {
      case 'tool':
        return (
          <div className="decision-row">
            <button type="button" disabled={busy} onClick={() => { run('allow') }}>
              <kbd>A</kbd> Engedélyez
            </button>
            <button type="button" disabled={busy} onClick={() => { run('deny') }}>
              <kbd>D</kbd> Tilt…
            </button>
            <button type="button" disabled={busy} onClick={() => { run('rule-project') }}>
              <kbd>P</kbd> Projekt-szabály…
            </button>
            <button type="button" disabled={busy} onClick={() => { run('rule-machine') }}>
              <kbd>G</kbd> Gépszintű szabály…
            </button>
          </div>
        )
      case 'edit':
        return (
          <div className="decision-row">
            <button type="button" disabled={busy} onClick={() => { run('allow') }}>
              <kbd>A</kbd> Engedélyez
            </button>
            <button type="button" disabled={busy} onClick={() => { run('deny') }}>
              <kbd>D</kbd> Tilt…
            </button>
            <button type="button" disabled={busy} onClick={() => { run('session-edits') }}>
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
              <span className="muted">A kérdés formátuma ismeretlen — itt nem válaszolható.</span>
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
  const limitNote = (
    <p className="muted">
      Levágva: csak az első {DETAILS_LIMIT.toLocaleString('hu-HU')} karakter látszik — a teljes
      szöveg a VSCode-ban.
    </p>
  )

  const agent = decision.agentType === undefined ? undefined : `subagent · ${decision.agentType}`
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
        {agent !== undefined && <span className="decision-agent">{agent}</span>}
      </header>
      <div className="decision-scroll">
        <pre className="decision-summary">{decision.summary}</pre>
        {decision.description !== undefined && <p className="decision-description">{decision.description}</p>}
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
                      <span key={index} className={`diff-line diff-${line.sign}`}>
                        {LINE_MARK[line.sign]} {line.text}
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
