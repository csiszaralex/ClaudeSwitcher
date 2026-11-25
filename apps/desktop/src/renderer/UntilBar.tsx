import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { WeeklyReset } from '../shared/excluded-sessions.js'
import { parseUntil, UNTIL_TEXT, untilPresets, type UntilParse } from './until-time.js'

/**
 * What the bar would confirm now: the focused preset's time; on an empty field the first preset's
 * (what Enter takes then); else the field's phrase (`parseUntil`).
 */
function choiceOf(focused: number, text: string, now: number, weeklyReset: WeeklyReset | undefined, limitResetsAt: number | undefined): UntilParse {
  const presets = untilPresets(now, weeklyReset, limitResetsAt)
  const preset = focused >= 0 ? presets[focused] : text.trim() === '' ? presets[0] : undefined
  if (preset !== undefined) return { kind: 'time', until: preset.until }
  return focused >= 0 ? { kind: 'unknown' } : parseUntil(text, now, weeklyReset)
}

/** The preview line of a choice: the resolved time in absolute form, or why Enter does nothing. */
function previewOf(choice: UntilParse, now: number): string {
  switch (choice.kind) {
    case 'time':
      return UNTIL_TEXT.preview(choice.until, now)
    case 'past':
      return UNTIL_TEXT.past
    case 'unknown':
      return UNTIL_TEXT.unknown
  }
}

/**
 * The time bar under a row (Shift+Delete, list-cleanup.ts `isTimedExcludeKey`): the presets
 * (`until-time.ts` `untilPresets`), a field for a Hungarian time phrase (`parseUntil`) and a preview
 * of the time it resolves to. Enter confirms the focused preset, or the field's phrase (on an empty
 * field the first preset); a phrase the bar cannot use (`Nem értem`, or a time gone already) does
 * nothing. Esc closes it without a change. Tab and Shift+Tab move the focus around the field and the
 * presets, ←/→ between the presets; a click on a preset confirms it.
 *
 * Every key pressed in it stays in it (`onKeyDown`, `onKeyUp`): neither App's window handler (the
 * list's arrows, Space, Delete, Backspace, Shift+A, and Esc's `escapeHides`) nor the decision panel's
 * key letters see it. React handles it at its root, before the event reaches the window, so a
 * waiting request's `a`, `d` or `s` typed here, or pressed with a preset focused, decides nothing,
 * and its Esc does not hide the overlay. It closes when the focus leaves it and when the window
 * loses the focus (the overlay hides); App closes it on `shown`.
 */
export function UntilBar({
  now,
  weeklyReset,
  limitResetsAt,
  onConfirm,
  onClose,
}: {
  /** App's one-second clock, for the presets and the preview. */
  now: number
  weeklyReset: WeeklyReset | undefined
  /** The session's usage limit reset time (`usage-limit.ts` `sessionUsageLimit`), for the `limit resetig` preset. */
  limitResetsAt: number | undefined
  onConfirm: (until: number) => void
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  // The focused item: -1 the field, else the index of a preset.
  const [focused, setFocused] = useState(-1)
  const bar = useRef<HTMLLIElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const presetButtons = useRef<(HTMLButtonElement | null)[]>([])
  const presets = untilPresets(now, weeklyReset, limitResetsAt)
  const choice = choiceOf(focused, text, now, weeklyReset, limitResetsAt)

  useEffect(() => {
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  /** Confirms what the bar shows, resolved again at this moment, so the time is never one already gone. */
  function confirm(index: number): void {
    const resolved = choiceOf(index, text, Date.now(), weeklyReset, limitResetsAt)
    if (resolved.kind === 'time') onConfirm(resolved.until)
  }

  /** The field and the presets in their focus order. */
  function focusables(): HTMLElement[] {
    return [field.current, ...presetButtons.current.slice(0, presets.length)].filter((element) => element !== null)
  }

  /** Focuses the item at `position` of `focusables`, counted around. */
  function moveFocus(position: number): void {
    const items = focusables()
    items[(position + items.length) % items.length]?.focus()
  }

  /** The position in `focusables` of the focused item: the field first, then the presets. */
  const position = focused + 1

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>): void {
    event.stopPropagation()
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        onClose()
        return
      case 'Enter':
        event.preventDefault()
        if (!event.repeat) confirm(focused)
        return
      case 'Tab':
        event.preventDefault()
        moveFocus(position + (event.shiftKey ? -1 : 1))
        return
      case 'ArrowLeft':
      case 'ArrowRight':
      {
        // In the field the arrows move the caret; on a preset they step to its neighbour, around.
        if (focused < 0) return
        event.preventDefault()
        const next = (focused + (event.key === 'ArrowRight' ? 1 : -1) + presets.length) % presets.length
        moveFocus(next + 1)
        return
      }
      default:
        return
    }
  }

  return (
    <li
      ref={bar}
      className="until-bar"
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        event.stopPropagation()
      }}
      onBlur={() => {
        // After the focus has moved: a move inside the bar (Tab to a preset) keeps it open.
        setTimeout(() => {
          const element = bar.current
          if (element !== null && !element.contains(document.activeElement)) onClose()
        }, 0)
      }}
    >
      {presets.map((preset, index) => (
        <button
          key={preset.label}
          ref={(element) => {
            presetButtons.current[index] = element
          }}
          type="button"
          className="until-preset"
          title={UNTIL_TEXT.preview(preset.until, now)}
          onFocus={() => {
            setFocused(index)
          }}
          // The focus stays where it is: a click confirms at once.
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            confirm(index)
          }}
        >
          {preset.label}
        </button>
      ))}
      <input
        ref={field}
        className="until-field"
        type="text"
        value={text}
        placeholder={UNTIL_TEXT.placeholder}
        aria-label={UNTIL_TEXT.fieldLabel}
        spellCheck={false}
        autoFocus
        onFocus={() => {
          setFocused(-1)
        }}
        onChange={(event) => {
          setText(event.target.value)
        }}
      />
      <span className={`until-preview ${choice.kind === 'time' ? '' : 'unusable'}`} aria-live="polite">
        {previewOf(choice, now)}
      </span>
      <span className="until-keys">{UNTIL_TEXT.keys}</span>
    </li>
  )
}
