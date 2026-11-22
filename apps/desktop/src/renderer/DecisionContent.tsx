import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useMemo, type JSX } from 'react'
import { LINE_MARK, panelContent } from './edit-preview.js'
import { gitExplanation } from './git-explain.js'
import type { SummaryView } from './summary-view.js'
import type { SessionHost } from '../shared/request-source.js'
import { sandboxDisabled } from '../shared/sandbox.js'
import { DETAILS_LIMIT } from './tool-details.js'

interface Props {
  decision: PendingDecisionView
  /**
   * The panel's `summaryView` of the request: its header shows the line count too. `undefined` when
   * the request shows no summary block (summary-view.ts `showsSummary`).
   */
  summary: SummaryView | undefined
  /** Where the session's own prompt is, which shows the full text. */
  host: SessionHost
}

/**
 * The scrolling middle of the decision panel: warning, description, the git lines of a Bash
 * command (git-explain.ts), command, preview and details. `null` when it has none of them.
 */
export function DecisionContent({ decision, summary, host }: Props): JSX.Element | null {
  // App re-renders every second (for its clocks); formatting a big script or comparing a file line
  // by line must not run on every tick.
  const { preview, details } = useMemo(() => panelContent(decision), [decision])
  const gitLines = useMemo(() => gitExplanation(decision), [decision])
  const limitNote = (
    <p className="muted">
      Levágva: csak az első {DETAILS_LIMIT.toLocaleString('hu-HU')} karakter látszik. A teljes
      szöveg {host.inside} látható.
    </p>
  )

  const sandboxOff = sandboxDisabled(decision.toolInput)
  const hasDetails = details !== undefined && details.blocks.length > 0
  // Nothing to show, e.g. a question or a plan whose own view shows the content (summary-view.ts
  // `showsSummary`): no scrolling area at all, so its `min-height` (styles.css `.decision-scroll`)
  // leaves no empty band.
  if (
    !sandboxOff &&
    decision.description === undefined &&
    gitLines.length === 0 &&
    summary === undefined &&
    preview === undefined &&
    !hasDetails
  ) {
    return null
  }

  return (
    <div className="decision-scroll">
      {sandboxOff && (
        <p className="decision-warning">Sandbox nélkül futna (dangerouslyDisableSandbox: true).</p>
      )}
      {/* The description above the command: below a long command it would not show without scrolling. */}
      {decision.description !== undefined && <p className="decision-description">{decision.description}</p>}
      {/* What each git call does, between Claude's own words and the command they explain. */}
      {gitLines.map((line, index) => (
        <p key={index} className={line.level === 'danger' ? 'decision-warning' : 'git-explain'}>
          {line.level === 'danger' && 'Veszélyes: '}
          <code className="git-call">{line.call}</code> · {line.text}
        </p>
      ))}
      {summary !== undefined && (
        <pre className="decision-summary">
          {summary.segments.map((segment, index) =>
            // The escape of an invisible character is highlighted, so it cannot be taken for part of the command.
            segment.hidden ? (
              <span key={index} className="invisible-char">
                {segment.text}
              </span>
            ) : (
              segment.text
            ),
          )}
        </pre>
      )}
      {summary?.truncated === true && limitNote}
      {preview !== undefined && (
        // Open by default: this is the content to approve itself. A native <details>, so it can be collapsed.
        <details className="decision-details edit-preview" open>
          <summary>Előnézet</summary>
          {preview.blocks.map((block) => (
            <div key={block.title}>
              <div className="muted">
                {block.title}
                {block.notes.length > 0 && ` · ${block.notes.join(' · ')}`}
              </div>
              {block.lines.length > 0 && (
                <pre>
                  {block.lines.map((line, index) => (
                    // The content of a <pre> may only be phrasing elements: a block span, not a <div>.
                    // The sign is a CSS pseudo-element (`data-mark`), not text: so copied lines give
                    // exactly the file's content, without the sign and space column.
                    <span key={index} className={`diff-line diff-${line.sign}`} data-mark={LINE_MARK[line.sign]}>
                      {line.text}
                    </span>
                  ))}
                </pre>
              )}
              {block.hiddenLines > 0 && (
                <p className="muted">… {block.hiddenLines.toLocaleString('hu-HU')} további sor</p>
              )}
            </div>
          ))}
          {preview.truncated && limitNote}
        </details>
      )}
      {hasDetails && (
        // A native <details>: it opens from the keyboard (Tab, Space) without code of our own.
        <details className="decision-details">
          <summary>Részletek</summary>
          {details.blocks.map((block) => (
            <div key={block.label === undefined ? 'json' : `field:${block.label}`}>
              {block.label !== undefined && <div className="muted">{block.label}</div>}
              <pre>{block.text}</pre>
            </div>
          ))}
          {details.truncated && limitNote}
        </details>
      )}
    </div>
  )
}
