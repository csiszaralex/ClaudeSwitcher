import type { AskQuestion } from '@claudeswitcher/core'
import { useState, type JSX } from 'react'
import { buildAnswers, initialFormState, isComplete, setOtherText, toggleOption } from './question-form.js'

interface Props {
  questions: readonly AskQuestion[]
  busy: boolean
  onSubmit: (answers: Record<string, string>) => void
}

/** A session kérdései válaszolható formában. Amíg minden kérdésre nincs válasz, nem küldhető el. */
export function QuestionForm({ questions, busy, onSubmit }: Props): JSX.Element {
  const [state, setState] = useState(() => initialFormState(questions))
  const complete = isComplete(questions, state)

  return (
    <form
      className="question-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (complete && !busy) onSubmit(buildAnswers(questions, state))
      }}
    >
      {/* A kérdések görgetnek, a küldés gombja alul marad (lásd DecisionPanel). */}
      <div className="question-list">
        {questions.map((question, index) => (
          <fieldset key={question.question}>
            <legend>
              {question.header === undefined ? '' : `${question.header} — `}
              {question.question}
            </legend>
            {question.options.map((option) => (
              <label key={option.label} className="option">
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'}
                  name={`question-${String(index)}`}
                  checked={state[question.question]?.selected.includes(option.label) ?? false}
                  onChange={() => {
                    setState((current) => toggleOption(current, question, option.label))
                  }}
                />{' '}
                {option.label}
                {option.description !== undefined && <span className="muted"> — {option.description}</span>}
              </label>
            ))}
            <input
              className="other"
              placeholder="Egyéb (szabad szöveg)"
              value={state[question.question]?.other ?? ''}
              onChange={(event) => {
                const text = event.target.value
                setState((current) => setOtherText(current, question, text))
              }}
            />
          </fieldset>
        ))}
      </div>
      <div className="decision-row">
        <button type="submit" disabled={!complete || busy}>
          Válasz elküldése
        </button>
      </div>
    </form>
  )
}
