import type { PermissionRule } from '@claudeswitcher/core'
import { parseRules } from '@claudeswitcher/core/browser'
import { useState, type JSX } from 'react'

interface Props {
  /** A Claude Code javaslata, soronként egy szabály — a felhasználó átírhatja. */
  initial: string
  /** Gépszint: minden projektre és sessionre hat, ezért külön megerősítés kell. */
  machine: boolean
  busy: boolean
  onSubmit: (rules: PermissionRule[]) => void
  onCancel: () => void
}

/**
 * A szabály szerkeszthető előnézete. Amíg egy sor nem értelmezhető, nem lehet beküldeni: egy
 * csendben „javított" szabály más engedélyt adna, mint amit a felhasználó lát.
 */
export function RuleEditor({ initial, machine, busy, onSubmit, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(initial)
  const [confirmed, setConfirmed] = useState(false)

  const parsed = parseRules(text)
  const rules = parsed.ok ? parsed.rules : []
  const problem = !parsed.ok
    ? `A ${parsed.line}. sor nem szabály: „${parsed.text}"`
    : rules.length === 0
      ? 'Legalább egy szabály kell.'
      : undefined
  const canSubmit = problem === undefined && !busy && (!machine || confirmed)

  return (
    <form
      className="rule-editor"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) onSubmit(rules)
      }}
    >
      <p className="muted">
        {machine
          ? 'Gépszintű szabály — minden projektre és sessionre érvényes (~/.claude/settings.json).'
          : 'Projekt-szabály — csak ebben a projektben (.claude/settings.local.json).'}
      </p>
      <textarea
        autoFocus
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
          if (event.key === 'Enter' && event.ctrlKey && canSubmit) {
            event.preventDefault()
            onSubmit(rules)
          }
        }}
      />
      {problem !== undefined && <p className="decision-error">{problem}</p>}
      {machine && (
        <label className="confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked)
            }}
          />{' '}
          Értem, hogy ez a gép minden sessionjére érvényes
        </label>
      )}
      <div className="decision-row">
        <button type="submit" disabled={!canSubmit}>
          Engedélyez és felveszi a szabályt
        </button>
        <button type="button" onClick={onCancel}>
          Mégse
        </button>
      </div>
    </form>
  )
}
