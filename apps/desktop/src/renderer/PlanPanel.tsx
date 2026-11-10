import { useState, type JSX } from 'react'
import { isSubmitChord, SUBMIT_CHORD_LABEL } from './decision-actions.js'

interface Props {
  plan: string | undefined
  busy: boolean
  onReject: (feedback: string) => void
  onJump: () => void
}

/**
 * The plan with its full text. It can be rejected here too, with feedback: the session plans again
 * from it (measured, case K3 in spikes/m2-permission/RESULTS.md). Approving works only in VS Code:
 * Claude Code ignores an approval given from the hook (three independent measurements, cases
 * K2/K2b/K2c there).
 */
export function PlanPanel({ plan, busy, onReject, onJump }: Props): JSX.Element {
  const [feedback, setFeedback] = useState('')
  const canReject = feedback.trim() !== '' && !busy

  return (
    <div className="plan-panel">
      <pre className="plan">{plan ?? '(a terv szövege nem érkezett meg)'}</pre>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (canReject) onReject(feedback)
        }}
      >
        <textarea
          rows={2}
          value={feedback}
          placeholder="Mit változtasson a terven? (elutasításhoz kötelező)"
          onChange={(event) => {
            setFeedback(event.target.value)
          }}
          onKeyDown={(event) => {
            // As in the rule editor: Ctrl+Enter submits from the field, a plain Enter starts a new line.
            if (isSubmitChord(event) && canReject) {
              event.preventDefault()
              onReject(feedback)
            }
          }}
        />
        <div className="decision-row">
          <button type="submit" disabled={!canReject}>
            <kbd>{SUBMIT_CHORD_LABEL}</kbd> Elutasítás visszajelzéssel
          </button>
          <button type="button" onClick={onJump}>
            Jóváhagyás a VSCode-ban →
          </button>
        </div>
      </form>
    </div>
  )
}
