import type { UserDecision } from '@claudeswitcher/core'
import { UNREADABLE_REQUEST } from '@claudeswitcher/core/browser'
import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useMemo, useState, type JSX, type RefObject } from 'react'
import { errorMessage } from '../shared/error-message.js'
import {
  ACTION_BUTTONS,
  DENY_BUTTON,
  isTypingTarget,
  isUnreadableQuestion,
  readDecideResult,
  shortcutFor,
  type ActionButton,
  type DecisionAction,
} from './decision-actions.js'
import { DecisionContent } from './DecisionContent.js'
import { JumpButton } from './JumpButton.js'
import { armUntil, isArmed, shortcutAllowed, type KeyHistory } from './key-guard.js'
import { PlanPanel } from './PlanPanel.js'
import { QuestionForm } from './QuestionForm.js'
import { RuleEditor } from './RuleEditor.js'
import { ruleEditorSeed, suggestionTooltip } from './rule-editor.js'
import { releasedMessage } from './session-marker.js'
import { summaryView } from './summary-view.js'

function isRuleAction(action: DecisionAction): boolean {
  return action === 'rule-project' || action === 'rule-machine'
}

const KIND_LABEL = {
  tool: 'Engedélyt kér',
  edit: 'Fájlt írna',
  question: 'Kérdez',
  plan: 'Tervet hagyatna jóvá',
} as const

type Mode = 'buttons' | Extract<DecisionAction, 'deny' | 'rule-project' | 'rule-machine'>

interface Props {
  decision: PendingDecisionView
  /** The requesting subagent's label in the header (format.ts `subagentLabel`); absent for the main session. */
  agentLabel: string | undefined
  /** Whether the session has a Remote Control connection (session-marker.ts `hasRemoteControl`): it picks the released request's text. */
  remoteControl: boolean
  /** App's key history: the overlay's appearance and the last keystroke in a text field (key-guard.ts). */
  keyHistory: RefObject<KeyHistory>
  /** The daemon accepted the decision: from this App steps the selection or hides the overlay. */
  onDecided: () => void
  /** Jumps to the session's VS Code window: the native prompt is there all along. */
  onJump: () => void
}

/**
 * The decision panel of one pending request. The daemon checks and forwards the decision through
 * the main process; on success the next state removes the request, and the panel disappears.
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
      setError(errorMessage(caught))
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

  // Arming: the panel mounts again for every request (App's `key={decision.id}`), so this restarts
  // on every new request. The overlay's appearance re-arms it through `keyHistory`.
  const [mountArmedAt] = useState(() => armUntil(Date.now()))
  function armedAt(): number {
    return Math.max(mountArmedAt, keyHistory.current.shownArmedAt)
  }
  // The allowing buttons are disabled until armed: the second half of a double click lands on the
  // same spot and would press the next request's button. Deny, jump and cancel work unarmed too.
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

  // The key letters. They have no effect with an open form, while a request is in flight, and on a
  // released request; the other conditions (repeat, modifiers, text field, arming, the pause after
  // typing) are in key-guard.ts.
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
        <JumpButton onJump={onJump} />
      </div>
    )
  }

  /**
   * One button of the table (decision-actions.ts `ACTION_BUTTONS`). `title` and `kbdClass` are for
   * the rule buttons' suggestion mark.
   */
  function actionButton(button: ActionButton, title?: string, kbdClass?: string): JSX.Element {
    return (
      <button
        key={button.action}
        type="button"
        disabled={busy || (button.needsArming && !armed)}
        title={title}
        onClick={() => {
          run(button.action)
        }}
      >
        <kbd className={kbdClass}>{button.key.toUpperCase()}</kbd>
        {` ${button.label}`}
      </button>
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

    // An unreadable command, file or URL: the core would reject allowing anyway. The row must not be
    // a dead end: denying works, and the native prompt is there in VS Code.
    if (!decision.readable) {
      return (
        <div className="decision-row">
          <span className="muted">{UNREADABLE_REQUEST}</span>
          {actionButton(DENY_BUTTON)}
          <JumpButton onJump={onJump} />
        </div>
      )
    }

    switch (decision.kind) {
      case 'tool': {
        // Claude Code's suggestion fills the editor of both rule buttons, so both get a mark: the key
        // letter is inverted (orange background), so the button row stays on one line. The rule is
        // in the tooltip.
        const suggestion = suggestionTooltip(decision.suggestedRules)
        const ruleKey = suggestion === undefined ? undefined : 'suggested'
        return (
          <div className="decision-row">
            {ACTION_BUTTONS.tool.map((button) =>
              isRuleAction(button.action) ? actionButton(button, suggestion, ruleKey) : actionButton(button),
            )}
          </div>
        )
      }
      case 'edit':
        return <div className="decision-row">{ACTION_BUTTONS.edit.map((button) => actionButton(button))}</div>
      case 'question':
        // An unreadable question cannot be answered (the daemon would reject it too), but the row
        // must not be a dead end: the native prompt is there in VS Code, or the session gets a deny
        // with a message.
        if (isUnreadableQuestion(decision)) {
          return (
            <div className="decision-row">
              <span className="muted">A kérdés formátuma ismeretlen, itt nem válaszolható.</span>
              <button type="button" disabled={busy} onClick={() => { setMode('deny') }}>
                Tilt…
              </button>
              <JumpButton onJump={onJump} />
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

  // Memoised on the request, so the App's re-render every second (for its clocks) does not format
  // it again. The header shows its line count, `DecisionContent` its text.
  const summary = useMemo(() => summaryView(decision.summary), [decision])

  // For a question and a plan the action area itself is long (questions, plan text): there its
  // inside scrolls, and the submit buttons stay at the bottom.
  const fill = decision.kind === 'question' || decision.kind === 'plan'

  // The header on top, the action area at the bottom, the scrollable content between them: even
  // with a long command the user does not have to scroll to the buttons.
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
      <DecisionContent decision={decision} summary={summary} />
      <div className={fill ? 'decision-actions fill' : 'decision-actions'}>
        {body()}
        {error !== undefined && <p className="decision-error">{error}</p>}
      </div>
    </section>
  )
}
