/**
 * The part of a session its name is read from; the daemon's `SessionView` fits it. Both fields are
 * `unknown`: the renderer gets the session from the daemon's message, and `state-message.ts`
 * `sanitizeState` checks neither `name` nor `activity.tabTitle`, so a wrong type must not reach a text.
 */
export interface NamedSession {
  /** The daemon's name (`SessionView.name`): the registry's `name`, else the folder's name, else the id. */
  name?: unknown
  /** `SessionActivity.tabTitle`: what the session's tab shows in the VS Code extension (core `tab-title.ts`). */
  activity?: { tabTitle?: unknown } | undefined
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * The name the app shows for a session, everywhere it names one: the title its VS Code tab shows
 * (`activity.tabTitle`, core `tab-title.ts` `shownTabTitle`: the custom title over the AI title),
 * which is how the user knows the session; else the daemon's `name`, which Claude Code often derives
 * itself (the registry's `nameSource: "derived"`); else `''`.
 */
export function sessionName(session: NamedSession): string {
  const tabTitle = session.activity?.tabTitle
  if (nonEmpty(tabTitle)) return tabTitle
  return nonEmpty(session.name) ? session.name : ''
}

/**
 * The daemon's `name` when the app shows another name for the session (`sessionName`), so it stays
 * reachable (the row's tooltip, the search); `undefined` when it is the shown name or there is none.
 */
export function otherName(session: NamedSession): string | undefined {
  return nonEmpty(session.name) && session.name !== sessionName(session) ? session.name : undefined
}

/**
 * The tooltip of a session's name in the list: the shown name, and on a second line the daemon's
 * name when it differs (`otherName`).
 */
export function nameTooltip(session: NamedSession): string {
  const other = otherName(session)
  const shown = sessionName(session)
  return other === undefined ? shown : `${shown}\nMás néven: ${other}`
}
