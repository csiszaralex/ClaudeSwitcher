import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ACTION_BUTTONS, DENY_BUTTON, SUBMIT_CHORD_LABEL, shortcutFor } from './decision-actions.js'
import { DecisionPanel } from './DecisionPanel.js'
import { requestSource, sessionHost } from '../shared/request-source.js'
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

/** The panel's first render, without effects: what the user sees at the moment it appears. */
function render(decision: PendingDecisionView, shownArmedAt = 0, entrypoint?: string): string {
  return renderToStaticMarkup(
    createElement(DecisionPanel, {
      decision,
      source: requestSource(entrypoint),
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

  it('shows the line count of a multi-line command in the header', () => {
    expect(render(bashDecision({ summary: 'node a.js\nnode b.js' }))).toContain('decision-lines')
  })
})

describe('question request', () => {
  const question = (text: string, header: string) => ({
    question: text,
    header,
    multiSelect: false,
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  })

  it('shows each question once, in its form, without the summary block or its line count', () => {
    const first = 'Which build\nshould run first?'
    const html = render(
      bashDecision({
        kind: 'question',
        toolName: 'AskUserQuestion',
        toolInput: {},
        summary: first,
        description: undefined,
        questions: [question(first, 'Build'), question('Which target?', 'Target')],
      }),
    )
    expect(html).not.toContain('decision-summary')
    expect(html).not.toContain('decision-lines')
    expect(html.split(first)).toHaveLength(2)
    expect(html).toContain('Which target?')
    // Nothing else goes into the scrolling area, so it is left out instead of showing an empty band.
    expect(html).not.toContain('decision-scroll')
  })

  it('shows the question in the summary block once the app released it: only the jump row is below', () => {
    const html = render(
      bashDecision({
        kind: 'question',
        toolName: 'AskUserQuestion',
        toolInput: {},
        summary: 'Which one?',
        description: undefined,
        questions: [question('Which one?', 'Pick')],
        released: true,
      }),
    )
    expect(html).toContain('<pre class="decision-summary">Which one?</pre>')
    expect(html).toContain('Az app elengedte.')
  })

  it('offers the deny button by its full label when the questions cannot be read', () => {
    const html = render(
      bashDecision({ kind: 'question', toolName: 'AskUserQuestion', toolInput: {}, summary: 'AskUserQuestion', questions: [] }),
    )
    expect(html).toContain(`>${DENY_BUTTON.label}</button>`)
  })
})

describe('plan request', () => {
  const planText = '# Rename the build step\n\nThen run it.'
  const plan = (released: boolean) =>
    bashDecision({
      kind: 'plan',
      toolName: 'ExitPlanMode',
      toolInput: { plan: planText },
      plan: planText,
      summary: 'Rename the build step',
      description: undefined,
      released,
    })

  it('shows the plan once, in the plan panel, without the summary block or an empty scrolling area', () => {
    const html = render(plan(false))
    expect(html).not.toContain('decision-summary')
    expect(html).not.toContain('decision-scroll')
    expect(html.split('Rename the build step')).toHaveLength(2)
  })

  it('shows the plan title in the summary block once the app released it', () => {
    const html = render(plan(true))
    expect(html).toContain('<pre class="decision-summary">Rename the build step</pre>')
    expect(html).not.toContain('class="plan"')
  })
})

describe('request source', () => {
  it('shows the label, the full folder and a non-default mode, plain for VS Code', () => {
    const html = render(bashDecision({ permissionMode: 'acceptEdits' }), 0, 'claude-vscode')
    expect(html).toContain('>VS Code</span>')
    expect(html).not.toContain('stands-out')
    expect(html).toContain('p:\\proj\\alpha · mód: acceptEdits')
  })

  it('emphasises a headless run', () => {
    const html = render(bashDecision(), 0, 'sdk-cli')
    expect(html).toContain('source-label stands-out')
    expect(html).toContain('>claude -p</span>')
    expect(html).not.toContain('mód:')
  })

  it('emphasises a request whose session is not in the registry', () => {
    const html = render(bashDecision())
    expect(html).toContain('source-label stands-out')
    expect(html).toContain('>ismeretlen</span>')
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
        host: sessionHost(undefined),
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

describe("the session's host in the texts", () => {
  const plan = bashDecision({ kind: 'plan', toolName: 'ExitPlanMode', plan: '# Plan', summary: 'Plan' })

  it('keeps the VS Code wording for an extension session', () => {
    const released = render(bashDecision({ released: true }), 0, 'claude-vscode')
    expect(released).toContain('A VSCode-ban még dönthetsz.')
    expect(released).toContain('Ugrás a VSCode-ba')
    expect(render(plan, 0, 'claude-vscode')).toContain('Jóváhagyás a VSCode-ban →')
  })

  it('names the terminal for a CLI session and a claude -p run', () => {
    for (const entrypoint of ['cli', 'sdk-cli']) {
      const released = render(bashDecision({ released: true }), 0, entrypoint)
      expect(released).toContain('A terminálban még dönthetsz.')
      expect(released).toContain('Ugrás a terminálhoz')
      expect(released).not.toContain('VSCode')
      expect(render(plan, 0, entrypoint)).toContain('Jóváhagyás a terminálban →')
    }
  })

  it('names the session itself when the source is unknown', () => {
    for (const entrypoint of [undefined, 'sdk-future']) {
      const released = render(bashDecision({ released: true }), 0, entrypoint)
      expect(released).toContain('A sessionben még dönthetsz.')
      expect(released).toContain('Ugrás a sessionhöz')
      expect(render(plan, 0, entrypoint)).toContain('Jóváhagyás a sessionben →')
    }
  })

  it('names the host where a long command is cut and on an unreadable request', () => {
    const long = render(bashDecision({ summary: 'x'.repeat(50_000) }), 0, 'cli')
    expect(long).toContain('A teljes')
    expect(long).toContain('a terminálban.')
    expect(render(bashDecision({ readable: false }), 0, 'cli')).toContain('Ugrás a terminálhoz')
  })

  it('names the host in the rule editor when a multi-line suggestion was left out', () => {
    const html = renderToStaticMarkup(
      createElement(RuleEditor, {
        initial: '',
        multilineSuggestions: 1,
        machine: false,
        busy: false,
        host: sessionHost('cli'),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    )
    expect(html).toContain('dönts a terminálban.')
  })
})

describe('rule suggestion mark', () => {
  /** The full markup of the P and the G button, from the opening tag to `</button>`. */
  function ruleButtons(html: string): string[] {
    return [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*?<kbd[^>]*>[PG]<\/kbd>(?:(?!<\/button>).)*<\/button>/g)].map(
      (match) => match[0],
    )
  }

  it('marks both rule buttons and names the suggested rule in their tooltip', () => {
    const html = render(bashDecision({ suggestedRules: [{ toolName: 'Bash', ruleContent: 'node -e *' }] }))
    const buttons = ruleButtons(html)
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toContain('title="A Claude Code szabályt javasol:\nBash(node -e *)"')
      expect(button).toMatch(/<kbd class="suggested">[PG]<\/kbd>/)
    }
  })

  it('changes nothing without a suggestion', () => {
    const buttons = ruleButtons(render(bashDecision()))
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).not.toContain('title=')
      expect(button).not.toContain('class="suggested"')
    }
  })
})

describe('arming a newly selected request', () => {
  /** The full markup of the A (allow) button. */
  function allowButton(html: string): string | undefined {
    return /<button[^>]*><kbd>A<\/kbd>[^<]*<\/button>/.exec(html)?.[0]
  }

  it('keeps the allow button disabled on a freshly mounted panel, even long after the overlay was shown', () => {
    // When the selection jumps, the panel mounts with the new request (App's `key={decision.id}`):
    // the old arming from the overlay's appearance does not arm the new request.
    const html = render(bashDecision(), Date.now() - 60_000)
    expect(allowButton(html)).toContain('disabled=""')
  })
})

describe('decision buttons', () => {
  const decisions = [
    bashDecision(),
    bashDecision({
      kind: 'edit',
      toolName: 'Write',
      toolInput: { file_path: 'p:\\proj\\alpha\\a.txt', content: 'a' },
      summary: 'p:\\proj\\alpha\\a.txt',
      description: undefined,
    }),
  ]
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index))

  /** The key letters on the rendered buttons, lower case and sorted. */
  function buttonKeys(html: string): string[] {
    return [...html.matchAll(/<button[^>]*><kbd[^>]*>([A-Z])<\/kbd>/g)].map((match) => match[1]!.toLowerCase()).sort()
  }

  it('every shortcut has a button with that key', () => {
    for (const decision of decisions) {
      for (const readable of [true, false]) {
        const shortcuts = letters.filter((letter) => shortcutFor(decision.kind, letter, readable) !== undefined)
        expect(buttonKeys(render({ ...decision, readable })), `${decision.kind}, readable: ${String(readable)}`).toEqual(
          shortcuts,
        )
      }
      for (const button of ACTION_BUTTONS[decision.kind]) {
        expect(shortcutFor(decision.kind, button.key, true)).toBe(button.action)
      }
    }
  })
})
