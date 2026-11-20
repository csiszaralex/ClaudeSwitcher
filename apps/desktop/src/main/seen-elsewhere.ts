import path from 'node:path'
import type { SessionStatus } from '@claudeswitcher/core'
import { VSCODE_ENTRYPOINT } from '../shared/entrypoint.js'
import type { LinkedSession } from '../shared/prompt-links.js'
import { finishState, type SeenFinishes } from '../shared/session-finished.js'
import type { ForegroundTitle } from './focus-window.js'

/**
 * How long a finished session's tab must stay the active tab of the foreground VS Code window, with
 * the same match all along (`createSeenWatch`), before its finish counts as seen. Agreed with the
 * owner: long enough that a tab clicked past on the way does not count, short enough for a glance
 * (measured: glances of 0.5 to 1.6 s, `docs/design.md` "The window title and the tab title"). With
 * the poll below, a match counts after 1 to 1.25 s.
 */
export const SEEN_DWELL_MS = 1000

/** How often `main/index.ts` reads the foreground window while a finish may be seen this way (`watchesSeen`). */
export const SEEN_POLL_MS = 250

/**
 * The part of a session the match reads; the daemon's `SessionView` fits it. The links
 * (`LinkedSession`) tell whether a finished session still waits on the ones it prompted, which is
 * no finish to see (`finishState`).
 */
export interface SeenSession extends LinkedSession {
  sessionId: string
  status: SessionStatus
  stoppedAt?: number | undefined
  entrypoint?: string | undefined
  windowPid?: number | undefined
  workspaceFolder?: string | undefined
  activity: NonNullable<LinkedSession['activity']> & { tabTitle?: string | undefined }
}

/**
 * How VS Code cuts a long title in the window title: the first characters, then U+2026. Measured
 * (`docs/design.md` "The window title and the tab title"): 24 characters, then `…`. The exact length
 * is not measured, so a cut title matches by prefix and the length is not used.
 */
const CUT_MARK = '…'

/**
 * The gaps around a piece: the characters before (`GAP_BEFORE`) or after (`GAP_AFTER`) it up to the
 * nearest letter or digit. Unicode-aware, so Hungarian letters are letters; a combining mark counts
 * as part of its letter.
 */
const GAP_AFTER = /^[^\p{L}\p{M}\p{N}]*/u
const GAP_BEFORE = /[^\p{L}\p{M}\p{N}]*$/u
const WHITESPACE = /\s/u
const NOT_WHITESPACE = /\S/u

/**
 * Whether the gap between a piece and the next letter or digit (`gap`, none of them letters or
 * digits) separates the piece from the rest of the title: it reaches the title's edge, or it holds a
 * space and something that is not a space, as the default separator `' - '` does, and a `${dirty}`
 * mark (a symbol and a space) in front of the title. A lone space between words ("Marketing plan.md") or the dot of a file extension
 * ("Marketing.md") does not, so a session titled "Marketing" does not match those file tabs. The
 * title is never split by position or by separator: the user's `window.title` template decides both.
 */
function separates(gap: string, reachesEdge: boolean): boolean {
  if (reachesEdge) return true
  return WHITESPACE.test(gap) && NOT_WHITESPACE.test(gap)
}

/** Whether `title` holds a piece from `start` to `end` that stands on its own (`separates`). */
function isWholePiece(title: string, start: number, end: number): boolean {
  if (end <= start) return false
  const before = GAP_BEFORE.exec(title.slice(0, start))?.[0] ?? ''
  const after = GAP_AFTER.exec(title.slice(end))?.[0] ?? ''
  // No gap, and not at the edge: a letter or digit touches the piece, so it is part of a longer word.
  if ((before === '' && start > 0) || (after === '' && end < title.length)) return false
  return separates(before, before.length === start) && separates(after, end + after.length === title.length)
}

/** Whether `piece` occurs in `title` as a whole piece (`isWholePiece`), anywhere. */
export function showsWhole(title: string, piece: string): boolean {
  if (piece === '') return false
  for (let at = title.indexOf(piece); at !== -1; at = title.indexOf(piece, at + 1)) {
    if (isWholePiece(title, at, at + piece.length)) return true
  }
  return false
}

/**
 * Whether the window title shows the tab title: whole, or cut (`CUT_MARK`): a whole piece that is a
 * shorter, non-empty prefix of the tab title followed by `…`.
 */
export function showsTabTitle(windowTitle: string, tabTitle: string): boolean {
  if (showsWhole(windowTitle, tabTitle)) return true
  for (let cut = windowTitle.indexOf(CUT_MARK); cut !== -1; cut = windowTitle.indexOf(CUT_MARK, cut + 1)) {
    for (let start = 0; start < cut; start++) {
      const prefix = windowTitle.slice(start, cut)
      if (prefix.length >= tabTitle.length || !tabTitle.startsWith(prefix)) continue
      if (isWholePiece(windowTitle, start, cut + CUT_MARK.length)) return true
    }
  }
  return false
}

/** A session whose tab can be told in a VS Code window title: an extension session with a window and a tab title. */
function tabTitleIn(session: SeenSession): string | undefined {
  if (session.entrypoint !== VSCODE_ENTRYPOINT || session.windowPid === undefined) return undefined
  return session.activity.tabTitle
}

/**
 * Whether any finish could be seen this way now: an unseen finish (`finishState`) of an extension
 * session with a window and a tab title. `main/index.ts` reads the foreground window only while this
 * holds. A session outside VS Code (a CLI in a terminal) never counts: not measured.
 */
export function watchesSeen(sessions: readonly SeenSession[], seen: SeenFinishes): boolean {
  return sessions.some((s) => tabTitleIn(s) !== undefined && finishState(s, seen, sessions) === 'unseen')
}

/**
 * The session whose tab the foreground window shows now, if its finish is unseen, else `undefined`.
 *
 * The candidates are the extension sessions of the foreground window's process (`windowPid`; every
 * VS Code window belongs to one process, measured, so the pid only says "this VS Code") whose tab
 * title the window title shows (`showsTabTitle`), whatever their state: a working or seen session
 * with the same title competes too, so the user looking at it does not acknowledge another one.
 * With several, only those whose workspace folder's base name the title also shows as a whole
 * piece stay (`${rootName}`). The match needs exactly one, and that one's finish unseen.
 */
export function sessionInFront(
  foreground: ForegroundTitle,
  sessions: readonly SeenSession[],
  seen: SeenFinishes,
): SeenSession | undefined {
  let candidates = sessions.filter((s) => {
    const tabTitle = tabTitleIn(s)
    return tabTitle !== undefined && s.windowPid === foreground.pid && showsTabTitle(foreground.title, tabTitle)
  })
  if (candidates.length > 1) {
    candidates = candidates.filter((s) => {
      const folder = s.workspaceFolder === undefined ? '' : path.win32.basename(s.workspaceFolder)
      return showsWhole(foreground.title, folder)
    })
  }
  const [only] = candidates
  return candidates.length === 1 && only !== undefined && finishState(only, seen, sessions) === 'unseen' ? only : undefined
}

export interface SeenWatchInput {
  /** The foreground window now, or `undefined` when there is none to look at (unreadable, or the overlay is up). */
  foreground: ForegroundTitle | undefined
  sessions: readonly SeenSession[]
  seen: SeenFinishes
  now: number
}

/**
 * How long after a jump from the list (`jumpedTo`) the watch accepts no match at most. The jump
 * brings the window up first and opens the exact tab after it, so for a moment the window shows
 * the tab that was active before, which may be another unseen finish; without the hold that tab
 * would count as seen although the user opened a different one. The hold ends sooner once the
 * window shows the jump's own tab. The length is a bound, not a measurement: the time between the
 * window and the tab coming up was not measured.
 */
export const SEEN_JUMP_HOLD_MS = 5000

/**
 * The dwell over `sessionInFront`: `observe`, called every `SEEN_POLL_MS`, returns the session to
 * acknowledge (`acknowledgeFinish`) once the same match (the same window, session and finish) has
 * held for `SEEN_DWELL_MS`, and then only once. Any other match, or none, starts the dwell again.
 * After `jumpedTo`, nothing matches until the window shows that session's tab, for at most
 * `SEEN_JUMP_HOLD_MS`.
 */
export function createSeenWatch(dwellMs: number = SEEN_DWELL_MS): {
  observe(input: SeenWatchInput): SeenSession | undefined
  jumpedTo(sessionId: string, now: number): void
} {
  let current: { key: string; since: number } | undefined
  let hold: { sessionId: string; until: number } | undefined
  /** Whether the foreground window shows the tab of the jump's session (`hold`). */
  const showsJumpTarget = (foreground: ForegroundTitle, sessions: readonly SeenSession[], sessionId: string): boolean => {
    const target = sessions.find((s) => s.sessionId === sessionId)
    const tabTitle = target === undefined ? undefined : tabTitleIn(target)
    return tabTitle !== undefined && target?.windowPid === foreground.pid && showsTabTitle(foreground.title, tabTitle)
  }
  return {
    jumpedTo(sessionId, now) {
      hold = { sessionId, until: now + SEEN_JUMP_HOLD_MS }
      current = undefined
    },
    observe({ foreground, sessions, seen, now }) {
      if (hold !== undefined) {
        const arrived = foreground !== undefined && showsJumpTarget(foreground, sessions, hold.sessionId)
        if (arrived || now >= hold.until) {
          hold = undefined
        } else {
          current = undefined
          return undefined
        }
      }
      const match = foreground === undefined ? undefined : sessionInFront(foreground, sessions, seen)
      if (foreground === undefined || match === undefined) {
        current = undefined
        return undefined
      }
      const key = `${String(foreground.hwnd)}\n${match.sessionId}\n${String(match.stoppedAt)}`
      if (current?.key !== key) current = { key, since: now }
      if (now - current.since < dwellMs) return undefined
      current = undefined
      return match
    },
  }
}
