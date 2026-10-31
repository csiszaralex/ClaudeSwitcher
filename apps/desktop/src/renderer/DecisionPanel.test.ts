import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SUBMIT_CHORD_LABEL } from './decision-actions.js'
import { DecisionPanel } from './DecisionPanel.js'
import { RuleEditor } from './RuleEditor.js'

function bashDecision(overrides: Partial<PendingDecisionView> = {}): PendingDecisionView {
  return {
    id: 'd1',
    sessionId: '3f1c2a9e-7b4d-4e8a-9c21-5d6e7f8a9b0c',
    cwd: 'p:\\proj\\alpha',
    toolName: 'Bash',
    toolInput: { command: 'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'a\')"', description: 'Writes a.txt' },
    kind: 'tool',
    summary: 'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'a\')"',
    description: 'Writes a.txt',
    suggestedRules: [],
    questions: [],
    readable: true,
    createdAt: 1,
    released: false,
    ...overrides,
  }
}

/** A panel első renderje, effektek nélkül: ezt látja a felhasználó a megjelenés pillanatában. */
function render(decision: PendingDecisionView, shownArmedAt = 0): string {
  return renderToStaticMarkup(
    createElement(DecisionPanel, {
      decision,
      agentLabel: undefined,
      remoteControl: false,
      keyHistory: { current: { shownArmedAt, lastTypedAt: undefined } },
      onDecided: () => undefined,
      onJump: () => undefined,
    }),
  )
}

describe('DecisionPanel layout', () => {
  it('puts the description above the command, so a long command does not push it out of view', () => {
    const html = render(bashDecision())
    const description = html.indexOf('decision-description')
    const command = html.indexOf('decision-summary')
    expect(description).toBeGreaterThan(-1)
    expect(command).toBeGreaterThan(description)
  })

  it('keeps the sandbox warning above the description', () => {
    const html = render(
      bashDecision({ toolInput: { command: 'node -e "1"', description: 'Runs node', dangerouslyDisableSandbox: true } }),
    )
    expect(html.indexOf('decision-warning')).toBeGreaterThan(-1)
    expect(html.indexOf('decision-description')).toBeGreaterThan(html.indexOf('decision-warning'))
  })

  it('shows no description paragraph when the tool gives none', () => {
    expect(render(bashDecision({ description: undefined }))).not.toContain('decision-description')
  })
})

describe('Ctrl+Enter label', () => {
  const chordKbd = `<kbd>${SUBMIT_CHORD_LABEL}</kbd>`

  it('names Ctrl+Enter on the submit button of the plan feedback, where Enter starts a new line', () => {
    const html = render(bashDecision({ kind: 'plan', toolName: 'ExitPlanMode', plan: '# Plan', summary: 'Plan' }))
    expect(html).toContain('<textarea')
    expect(html).toContain(chordKbd)
  })

  it('names Ctrl+Enter on the submit button of the rule editor', () => {
    const html = renderToStaticMarkup(
      createElement(RuleEditor, {
        initial: 'Bash(node -e *)',
        multilineSuggestions: 0,
        machine: false,
        busy: false,
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    )
    expect(html).toContain('<textarea')
    expect(html).toContain(chordKbd)
  })

  it('has no label in the question form, whose fields are single-line and submit on Enter', () => {
    const html = render(
      bashDecision({
        kind: 'question',
        toolName: 'AskUserQuestion',
        summary: 'Which one?',
        questions: [{ question: 'Which one?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
      }),
    )
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain(SUBMIT_CHORD_LABEL)
  })
})
