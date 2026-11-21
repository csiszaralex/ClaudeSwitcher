import type { AskQuestion } from '@claudeswitcher/core'
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { SUBMIT_CHORD_LABEL } from './decision-actions.js'
import {
  buildAnswers,
  initialFormState,
  isAnswered,
  isComplete,
  questionTabLabel,
  setOtherText,
  toggleOption,
  type FormState,
} from './question-form.js'
import {
  initialCursor,
  nextUnanswered,
  otherCursor,
  questionKeyCommand,
  stepQuestion,
  type QuestionCommand,
  type QuestionPlace,
} from './question-keys.js'

/** The form's focus, for App's keys: Tab from the list enters it, a new show of the overlay leaves it. */
export interface QuestionFocus {
  /** Moves the focus onto the active question's cursor (its option box, or its free text field). */
  enter: () => void
  /** Takes the focus out of the form, if it is inside: the list's keys act again. */
  leave: () => void
}

interface Props {
  questions: readonly AskQuestion[]
  busy: boolean
  onSubmit: (answers: Record<string, string>) => void
  /** Filled while the form is shown, `null` otherwise. */
  focus: RefObject<QuestionFocus | null>
}

/** A click on a tab or an option does not take the focus: from the list, the list's keys keep working. */
function keepFocus(event: { preventDefault: () => void }): void {
  event.preventDefault()
}

/**
 * The session's questions, one at a time, with a tab per question above it when there are several.
 * It cannot be sent until every question has an answer. The keys are in question-keys.ts
 * (`questionKeyCommand`); every key pressed inside the form stays in it (`onKeyDown`).
 */
export function QuestionForm({ questions, busy, onSubmit, focus }: Props): JSX.Element {
  const [state, setState] = useState(() => initialFormState(questions))
  const [active, setActive] = useState(0)
  const [cursor, setCursor] = useState(0)
  // Bumped when the focus has to follow the cursor (`requestFocus`); the effect below moves it.
  const [focusRequest, setFocusRequest] = useState(0)
  const form = useRef<HTMLFormElement | null>(null)
  const optionBox = useRef<HTMLDivElement | null>(null)
  const otherField = useRef<HTMLInputElement | null>(null)
  const idPrefix = useId()
  const complete = isComplete(questions, state)
  const question = questions[active]

  function focusCursor(): void {
    if (question !== undefined && cursor === otherCursor(question)) otherField.current?.focus()
    else optionBox.current?.focus()
  }

  /** The focus follows the cursor after the next render, but only if it is in the form already. */
  function requestFocus(): void {
    if (form.current?.contains(document.activeElement) === true) setFocusRequest((count) => count + 1)
  }

  useEffect(() => {
    if (focusRequest > 0) focusCursor()
  }, [focusRequest])

  useEffect(() => {
    focus.current = {
      enter: focusCursor,
      leave: () => {
        const element = document.activeElement
        if (element instanceof HTMLElement && form.current?.contains(element) === true) element.blur()
      },
    }
    return () => {
      focus.current = null
    }
  })

  /** Opens the question at `index` with its cursor at its start; the same question stays as it is. */
  function open(index: number, nextState: FormState): void {
    const target = questions[index]
    if (index === active || target === undefined) return
    setActive(index)
    setCursor(initialCursor(target, nextState))
    requestFocus()
  }

  function send(): void {
    if (complete && !busy) onSubmit(buildAnswers(questions, state))
  }

  function run(command: QuestionCommand): void {
    if (question === undefined) return
    switch (command.type) {
      case 'cursor':
        setCursor(command.to)
        requestFocus()
        return
      case 'question':
        open(stepQuestion(active, command.step, questions.length), state)
        return
      case 'select': {
        const option = question.options[command.option]
        if (option === undefined) return
        const nextState = toggleOption(state, question, option.label)
        setState(nextState)
        setCursor(command.option)
        requestFocus()
        if (command.moveOn) open(nextUnanswered(questions, nextState, active), nextState)
        return
      }
      case 'move-on':
        open(nextUnanswered(questions, state, active), state)
        return
      case 'submit':
        send()
        return
      case 'leave': {
        const element = document.activeElement
        if (element instanceof HTMLElement) element.blur()
        return
      }
      case 'ignore':
        return
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    // Every key pressed inside the form is the form's: neither App's window handler (the list's
    // Enter, Delete, Backspace, Space, / and Ctrl+K, and Esc hiding the overlay) nor the decision
    // panel's key letters see it: React handles it at its root, before the event reaches the window.
    event.stopPropagation()
    if (question === undefined) return
    const place: QuestionPlace =
      event.target === optionBox.current ? 'options' : event.target === otherField.current ? 'other' : 'elsewhere'
    const command = questionKeyCommand(event, place, question, cursor)
    if (command === undefined) return
    event.preventDefault()
    run(command)
  }

  return (
    <form
      ref={form}
      className="question-form"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {questions.length > 1 && (
        <div className="question-tabs" role="tablist">
          {questions.map((item, index) => {
            const answered = isAnswered(item, state)
            return (
              <button
                key={item.question}
                type="button"
                role="tab"
                tabIndex={-1}
                aria-selected={index === active}
                className={`question-tab${index === active ? ' active' : ''}${answered ? ' answered' : ''}`}
                title={item.question}
                onMouseDown={keepFocus}
                onClick={() => {
                  open(index, state)
                }}
              >
                <span className="question-tab-mark">{answered ? '✓' : '○'}</span> {questionTabLabel(item, index)}
              </button>
            )
          })}
        </div>
      )}
      {/* The question scrolls, the submit button stays at the bottom (see DecisionPanel). */}
      {question !== undefined && (
        <div className="question-list">
          {questions.length === 1 && question.header !== undefined && question.header.trim() !== '' && (
            <p className="question-header">{question.header}</p>
          )}
          <p className="question-text">{question.question}</p>
          {/* The focus sits on this box while the cursor is on an option; the cursor is drawn, not focused. */}
          <div
            ref={optionBox}
            className="question-options"
            role={question.multiSelect ? 'group' : 'radiogroup'}
            aria-label={question.question}
            aria-activedescendant={cursor < otherCursor(question) ? `${idPrefix}-${String(cursor)}` : undefined}
            tabIndex={0}
          >
            {question.options.map((option, index) => {
              const selected = state[question.question]?.selected.includes(option.label) ?? false
              return (
                <div
                  key={option.label}
                  id={`${idPrefix}-${String(index)}`}
                  role={question.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  className={`option${selected ? ' selected' : ''}${index === cursor ? ' cursor' : ''}`}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    run({ type: 'select', option: index, moveOn: !question.multiSelect })
                  }}
                >
                  <span className="option-mark">{question.multiSelect ? (selected ? '☑' : '☐') : selected ? '◉' : '○'}</span>
                  <span className="option-label">
                    {index < 9 && <span className="option-number">{`${String(index + 1)}.`}</span>} {option.label}
                  </span>
                  {option.description !== undefined && <span className="option-description">{option.description}</span>}
                </div>
              )
            })}
          </div>
          <input
            ref={otherField}
            className="other"
            placeholder="Egyéb (szabad szöveg)"
            value={state[question.question]?.other ?? ''}
            onFocus={() => {
              setCursor(otherCursor(question))
            }}
            onChange={(event) => {
              const text = event.target.value
              setState((current) => setOtherText(current, question, text))
            }}
          />
        </div>
      )}
      <div className="decision-row">
        <button type="submit" disabled={!complete || busy}>
          <kbd>{SUBMIT_CHORD_LABEL}</kbd> Válasz elküldése
        </button>
      </div>
    </form>
  )
}
