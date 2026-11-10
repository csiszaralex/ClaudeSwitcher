import type { PermissionRule } from '@claudeswitcher/core'
import { parseRules } from '@claudeswitcher/core/browser'
import { useState, type JSX } from 'react'
import { isSubmitChord, SUBMIT_CHORD_LABEL } from './decision-actions.js'
import { broadRules, editorRows, suggestionCount } from './rule-editor.js'

interface Props {
  /** Claude Code's suggestion, one rule per line; the user can rewrite it. */
  initial: string
  /** How many suggestions were left out of the initial text because they contain a line break (rule-editor.ts `ruleEditorSeed`). */
  multilineSuggestions: number
  /** Machine level: it affects every project and session, so it needs a separate confirmation. */
  machine: boolean
  busy: boolean
  onSubmit: (rules: PermissionRule[]) => void
  onCancel: () => void
}

/**
 * The editable preview of the rule. While a line cannot be parsed it cannot be submitted: a
 * silently "fixed" rule would grant a different permission than the one the user sees.
 */
export function RuleEditor({ initial, multilineSuggestions, machine, busy, onSubmit, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(initial)
  const [machineConfirmed, setMachineConfirmed] = useState(false)
  // Which broad rule list the user confirmed. If the list changes, the checkbox must not carry the
  // confirmation over to another rule the user has not seen yet.
  const [broadConfirmedFor, setBroadConfirmedFor] = useState<string | undefined>()

  const parsed = parseRules(text)
  const rules = parsed.ok ? parsed.rules : []
  const problem = !parsed.ok
    ? `A ${parsed.line}. sor nem szabály: „${parsed.text}"`
    : rules.length === 0
      ? 'Legalább egy szabály kell.'
      : undefined

  const broad = broadRules(rules)
  const broadKey = broad
    .filter((warning) => warning.confirm)
    .map((warning) => warning.rule)
    .join('\n')
  const broadConfirmed = broadKey === '' || broadConfirmedFor === broadKey
  const canSubmit = problem === undefined && !busy && (!machine || machineConfirmed) && broadConfirmed

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
          ? 'Gépszintű szabály: minden projektre és sessionre érvényes (~/.claude/settings.json).'
          : 'Projekt-szabály: csak ebben a projektben (.claude/settings.local.json).'}
      </p>
      {multilineSuggestions > 0 && (
        <p className="decision-error">
          {suggestionCount(multilineSuggestions)}{' '}
          többsoros, ezért kimaradt: soronként egy szabályt olvasunk, így több, mást engedélyező
          szabállyá esne szét. Írj egysoros szabályt, vagy dönts a VSCode-ban.
        </p>
      )}
      <textarea
        autoFocus
        rows={editorRows(text)}
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
          if (isSubmitChord(event) && canSubmit) {
            event.preventDefault()
            onSubmit(rules)
          }
        }}
      />
      {problem !== undefined && <p className="decision-error">{problem}</p>}
      {broad.length > 0 && (
        <p className="decision-error">
          Az eszköz minden hívását engedélyezi: {broad.map((warning) => warning.rule).join(', ')}
        </p>
      )}
      {broadKey !== '' && (
        <label className="confirm">
          <input
            type="checkbox"
            checked={broadConfirmed}
            onChange={(event) => {
              setBroadConfirmedFor(event.target.checked ? broadKey : undefined)
            }}
          />{' '}
          Értem, hogy ez a szabály az eszköz minden hívását engedélyezi
        </label>
      )}
      {machine && (
        <label className="confirm">
          <input
            type="checkbox"
            checked={machineConfirmed}
            onChange={(event) => {
              setMachineConfirmed(event.target.checked)
            }}
          />{' '}
          Értem, hogy ez a gép minden sessionjére érvényes
        </label>
      )}
      <div className="decision-row">
        <button type="submit" disabled={!canSubmit}>
          <kbd>{SUBMIT_CHORD_LABEL}</kbd> Engedélyez és felveszi a szabályt
        </button>
        <span className="muted">{rules.length.toLocaleString('hu-HU')} szabály</span>
        <button type="button" onClick={onCancel}>
          Mégse
        </button>
      </div>
    </form>
  )
}
