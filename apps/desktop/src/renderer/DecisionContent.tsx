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
  // Az App másodpercenként újrarenderel (az órák miatt); egy nagy szkript formázása vagy egy
  // fájl soronkénti összevetése ne fusson le minden tikkre.
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
      {/* A leírás a parancs fölött: egy hosszú parancs alatt görgetés nélkül nem látszana. */}
      {decision.description !== undefined && <p className="decision-description">{decision.description}</p>}
      <pre className="decision-summary">
        {summary.segments.map((segment, index) =>
          // A láthatatlan karakter escape-je kiemelve, hogy ne lehessen a parancs részének nézni.
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
        // Alapból nyitva: ez maga a jóváhagyandó tartalom. Natív <details>, hogy összecsukható legyen.
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
                    // A <pre> tartalma csak szövegszintű elem lehet: blokk-span, nem <div>.
                    // Az előjel egy CSS pszeudo-elem (`data-mark`), nem szöveg: így a kimásolt
                    // sorok pontosan a fájl tartalmát adják, előjel- és szóközoszlop nélkül.
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
        // Natív <details>: billentyűzetről (Tab, Szóköz) saját kód nélkül nyitható.
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
