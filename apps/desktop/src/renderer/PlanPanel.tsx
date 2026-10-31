import { useState, type JSX } from 'react'
import { isSubmitChord, SUBMIT_CHORD_LABEL } from './decision-actions.js'

interface Props {
  plan: string | undefined
  busy: boolean
  onReject: (feedback: string) => void
  onJump: () => void
}

/**
 * A terv a teljes szövegével. Elutasítani itt is lehet, visszajelzéssel — abból tervez újra a
 * session (mérve, spike K3). Jóváhagyni csak a VSCode-ban: a hookból adott jóváhagyást a Claude
 * Code figyelmen kívül hagyja (három független mérés, spike K2/K2b/K2c).
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
            // Mint a szabályszerkesztőben: Ctrl+Enter küld a mezőből, a sima Enter új sort kezd.
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
