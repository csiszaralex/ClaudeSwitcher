import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useMemo, type JSX } from 'react'
import { LINE_MARK, panelContent } from './edit-preview.js'
import type { SummaryView } from './summary-view.js'
import { DETAILS_LIMIT, sandboxDisabled } from './tool-details.js'

interface Props {
  decision: PendingDecisionView
  /** The panel's `summaryView` of the request: its header shows the line count too. */
  summary: SummaryView
}

/** The scrolling middle of the decision panel: warning, description, command, preview and details. */
export function DecisionContent({ decision, summary }: Props): JSX.Element {
  // App re-renders every second (for its clocks); formatting a big script or comparing a file line
  // by line must not run on every tick.
  const { preview, details } = useMemo(() => panelContent(decision), [decision])
  const limitNote = (
    <p className="muted">
      Levágva: csak az első {DETAILS_LIMIT.toLocaleString('hu-HU')} karakter látszik. A teljes
      szöveg a VSCode-ban.
    </p>
  )

  return (
    <div className="decision-scroll">
      {sandboxDisabled(decision.toolInput) && (
        <p className="decision-warning">Sandbox nélkül futna (dangerouslyDisableSandbox: true).</p>
      )}
      {/* The description above the command: below a long command it would not show without scrolling. */}
      {decision.description !== undefined && <p className="decision-description">{decision.description}</p>}
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
      {summary.truncated && limitNote}
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
      {details !== undefined && details.blocks.length > 0 && (
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
