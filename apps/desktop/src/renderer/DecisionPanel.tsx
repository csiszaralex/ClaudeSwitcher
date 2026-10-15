import type { UserDecision } from '@claudeswitcher/core'
import { formatRule } from '@claudeswitcher/core/browser'
import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useState, type JSX } from 'react'
import { isTypingTarget, readDecideResult, shortcutFor, type DecisionAction } from './decision-actions.js'
import { RuleEditor } from './RuleEditor.js'

const KIND_LABEL = {
  tool: 'Engedélyt kér',
  edit: 'Fájlt írna',
  question: 'Kérdez',
  plan: 'Tervet hagyatna jóvá',
} as const

type Mode = 'buttons' | 'deny' | 'rule-project' | 'rule-machine'

interface Props {
  decision: PendingDecisionView
  /** Ugrás a session VSCode ablakára — ott a natív prompt végig megvan. */
  onJump: () => void
}

/**
 * Egy függő kérés döntési panelje. A döntést a main processzen át a daemon ellenőrzi és
 * továbbítja; siker esetén a következő állapot leveszi a kérést, és a panel eltűnik.
 */
export function DecisionPanel({ decision, onJump }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('buttons')
  const [denyText, setDenyText] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(choice: UserDecision): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const result = readDecideResult(await window.claudeswitcher.decide(decision.id, choice))
      if (!result.ok) setError(result.reason)
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
        return jumpRow('A kérdést a VSCode-ban tudod megválaszolni.')
      case 'plan':
        return jumpRow('A tervet a VSCode-ban tudod jóváhagyni.')
    }
  }

  const agent = decision.agentType === undefined ? undefined : `subagent · ${decision.agentType}`

  return (
    <section className="decision">
      <header className="decision-head">
        <span className="decision-kind">{KIND_LABEL[decision.kind]}</span>
        <span className="decision-tool">{decision.toolName}</span>
        {agent !== undefined && <span className="decision-agent">{agent}</span>}
      </header>
      <pre className="decision-summary">{decision.summary}</pre>
      {body()}
      {error !== undefined && <p className="decision-error">{error}</p>}
    </section>
  )
}
