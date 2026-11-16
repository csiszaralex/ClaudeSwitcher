import { CLI_ENTRYPOINT, HEADLESS_ENTRYPOINT, VSCODE_ENTRYPOINT } from './entrypoint.js'

/**
 * Where a session, and so each of its permission requests, comes from, as the row, the decision
 * panel and the status bar show it.
 */
export interface RequestSource {
  /** The label text. */
  label: string
  /**
   * True for a run the user did not start interactively: the row (when it has a request), the panel
   * and the status bar emphasise it, so such a request is not allowed by habit. Nothing is blocked.
   */
  standsOut: boolean
  /**
   * A Hungarian tooltip explaining the label. It speaks of the session, not of a request: the status
   * bar shows the label for a session without a request too.
   */
  title: string
}

/** The label of a session without a registry record, or a record without `entrypoint`. */
const UNKNOWN_LABEL = 'ismeretlen'

const KNOWN_LABELS: ReadonlyMap<string, string> = new Map([
  [VSCODE_ENTRYPOINT, 'VS Code'],
  [CLI_ENTRYPOINT, 'CLI'],
  [HEADLESS_ENTRYPOINT, 'claude -p'],
])

/** The sources a person starts interactively; every other source stands out. */
const INTERACTIVE_ENTRYPOINTS: ReadonlySet<string> = new Set([VSCODE_ENTRYPOINT, CLI_ENTRYPOINT])

/**
 * The source of a request from its session's registry `entrypoint`. `undefined` when the session has
 * no registry record (or the record lacks the field). A value without a measured meaning is shown raw.
 */
export function requestSource(entrypoint: string | undefined): RequestSource {
  if (entrypoint === undefined) {
    return {
      label: UNKNOWN_LABEL,
      standsOut: true,
      title: 'A session forrása ismeretlen: nincs a nyilvántartásban, vagy nem írja, honnan indult.',
    }
  }
  const standsOut = !INTERACTIVE_ENTRYPOINTS.has(entrypoint)
  return {
    label: KNOWN_LABELS.get(entrypoint) ?? entrypoint,
    standsOut,
    title: standsOut ? 'Nem interaktívan indított session.' : 'Ebből a környezetből indított session.',
  }
}

/**
 * The panel's line under the request: the full working folder and, when it is not the default, the
 * permission mode (raw). `undefined` when there is nothing to show.
 */
export function requestFacts(decision: { cwd: string; permissionMode?: string | undefined }): string | undefined {
  const parts: string[] = []
  if (decision.cwd !== '') parts.push(decision.cwd)
  if (decision.permissionMode !== undefined && decision.permissionMode !== 'default') {
    parts.push(`mód: ${decision.permissionMode}`)
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}
