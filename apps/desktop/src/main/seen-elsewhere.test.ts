import { describe, expect, it } from 'vitest'
import { acknowledgeFinish } from '../shared/session-finished.js'
import { CLI_ENTRYPOINT, VSCODE_ENTRYPOINT } from '../shared/entrypoint.js'
import type { ForegroundTitle } from './focus-window.js'
import {
  SEEN_DWELL_MS,
  SEEN_JUMP_HOLD_MS,
  SEEN_POLL_MS,
  createSeenWatch,
  sessionInFront,
  showsSessionTab,
  showsTabTitle,
  showsWhole,
  watchesSeen,
  type SeenSession,
} from './seen-elsewhere.js'

/** Invented values throughout: one VS Code process, two of its windows. */
const CODE_PID = 4242
const OTHER_PID = 5151
const STOPPED_AT = 1_800_000_000_000
const NONE_SEEN = new Map<string, number>()

const session = (id: string, tabTitle: string | undefined, over: Partial<SeenSession> = {}): SeenSession => ({
  sessionId: `7a1b2c3d-0000-4000-8000-00000000000${id}`,
  status: 'idle',
  stoppedAt: STOPPED_AT,
  entrypoint: VSCODE_ENTRYPOINT,
  windowPid: CODE_PID,
  workspaceFolder: 'p:\\proj\\alpha',
  activity: { tabTitle },
  ...over,
})

const window = (title: string, over: Partial<ForegroundTitle> = {}): ForegroundTitle => ({
  hwnd: 1001,
  pid: CODE_PID,
  title,
  ...over,
})

/** The owner's `window.title`: `${rootName}${separator}${activeEditorShort}`. */
const custom = (root: string, editor: string): string => `${root} - ${editor}`
/** VS Code's default on Windows, with an empty `${folderLocation}` and `${profileName}`. */
const vscodeDefault = (root: string, editor: string, dirty = ''): string =>
  `${dirty}${editor} - ${root} - Visual Studio Code`

describe('showsTabTitle', () => {
  it('finds the whole title in both templates', () => {
    expect(showsTabTitle(custom('alpha', 'CRM master'), 'CRM master')).toBe(true)
    expect(showsTabTitle(vscodeDefault('alpha', 'CRM master'), 'CRM master')).toBe(true)
  })

  it('finds a cut title by its prefix, in both templates', () => {
    const tab = 'Claude Code session manager app'
    const cut = 'Claude Code session mana\u2026'
    expect(showsTabTitle(custom('alpha', cut), tab)).toBe(true)
    expect(showsTabTitle(vscodeDefault('alpha', cut), tab)).toBe(true)
    // The cut does not depend on the length: any shorter prefix followed by the mark matches.
    expect(showsTabTitle(custom('alpha', 'Claude Code session man\u2026'), tab)).toBe(true)
    expect(showsTabTitle(custom('alpha', 'Claude Code session manag\u2026'), tab)).toBe(true)
  })

  it('does not take a cut text that is not a prefix of the title', () => {
    expect(showsTabTitle(custom('alpha', 'Claude Code session mono\u2026'), 'Claude Code session manager app')).toBe(false)
    // The prefix must stand on its own too.
    expect(showsTabTitle(custom('alpha', 'XClaude Code session mana\u2026'), 'Claude Code session manager app')).toBe(false)
  })

  it('takes the title only as a whole piece', () => {
    expect(showsTabTitle(custom('alpha', 'Marketing plan.md'), 'Marketing')).toBe(false)
    expect(showsTabTitle(vscodeDefault('alpha', 'Marketing plan.md'), 'Marketing')).toBe(false)
    expect(showsTabTitle(custom('alpha', 'Marketing.md'), 'Marketing')).toBe(false)
    expect(showsTabTitle(custom('alpha', 'Remarketing'), 'marketing')).toBe(false)
    expect(showsTabTitle(custom('alpha', 'AntiMarketing'), 'Marketing')).toBe(false)
    expect(showsTabTitle(custom('alpha', 'Marketing2'), 'Marketing')).toBe(false)
    expect(showsTabTitle(custom('alpha', 'Marketing'), 'Marketing')).toBe(true)
  })

  it('treats Hungarian letters as letters', () => {
    expect(showsTabTitle(custom('alpha', 'Számlázásé'), 'Számlázás')).toBe(false)
    expect(showsTabTitle(custom('alpha', 'Őszi Számlázás'), 'Számlázás')).toBe(false)
    expect(showsTabTitle(custom('alpha', 'Számlázás'), 'Számlázás')).toBe(true)
    // A combining accent belongs to its letter.
    expect(showsTabTitle(custom('alpha', 'Számla\u0301'), 'Számla')).toBe(false)
  })

  it('finds the title behind a dirty mark', () => {
    expect(showsTabTitle(vscodeDefault('alpha', 'CRM master', '\u25cf '), 'CRM master')).toBe(true)
  })

  it('does not match a file tab, or a title without the active editor', () => {
    expect(showsTabTitle(custom('alpha', 'index.ts'), 'CRM master')).toBe(false)
    expect(showsTabTitle('alpha', 'CRM master')).toBe(false)
  })
})

describe('showsWhole', () => {
  it('finds the folder name as a whole piece only', () => {
    expect(showsWhole(custom('alpha', 'x'), 'alpha')).toBe(true)
    expect(showsWhole(vscodeDefault('alpha', 'x'), 'alpha')).toBe(true)
    expect(showsWhole(custom('alpha-beta', 'x'), 'alpha')).toBe(false)
    expect(showsWhole(custom('alpha', 'x'), '')).toBe(false)
  })
})

describe('sessionInFront', () => {
  it('finds the unseen VS Code session whose tab the foreground window shows', () => {
    const one = session('1', 'CRM master')
    const other = session('2', 'Parser munka')
    expect(sessionInFront(window(custom('alpha', 'CRM master')), [one, other], NONE_SEEN)).toBe(one)
    expect(sessionInFront(window(vscodeDefault('alpha', 'Parser munka')), [one, other], NONE_SEEN)).toBe(other)
  })

  it('needs the foreground window to belong to the session\'s VS Code process', () => {
    const one = session('1', 'CRM master')
    expect(sessionInFront(window(custom('alpha', 'CRM master'), { pid: OTHER_PID }), [one], NONE_SEEN)).toBeUndefined()
  })

  it('skips a seen finish, a working session, and a session without a finish', () => {
    const one = session('1', 'CRM master')
    const seen = new Map<string, number>()
    acknowledgeFinish(seen, one, [])
    const title = window(custom('alpha', 'CRM master'))
    expect(sessionInFront(title, [one], seen)).toBeUndefined()
    expect(sessionInFront(title, [session('1', 'CRM master', { status: 'working' })], NONE_SEEN)).toBeUndefined()
    expect(sessionInFront(title, [session('1', 'CRM master', { stoppedAt: undefined })], NONE_SEEN)).toBeUndefined()
  })

  it('skips a session outside VS Code, or one without a window or a tab title', () => {
    const title = window(custom('alpha', 'CRM master'))
    expect(sessionInFront(title, [session('1', 'CRM master', { entrypoint: CLI_ENTRYPOINT })], NONE_SEEN)).toBeUndefined()
    expect(sessionInFront(title, [session('1', 'CRM master', { entrypoint: undefined })], NONE_SEEN)).toBeUndefined()
    expect(sessionInFront(title, [session('1', 'CRM master', { windowPid: undefined })], NONE_SEEN)).toBeUndefined()
    expect(sessionInFront(title, [session('1', undefined)], NONE_SEEN)).toBeUndefined()
  })

  it('acknowledges none when two sessions of one window show the same cut title', () => {
    const cut = window(custom('alpha', 'Claude Code session mana\u2026'))
    const sessions = [session('1', 'Claude Code session manager app'), session('2', 'Claude Code session manager v2')]
    expect(sessionInFront(cut, sessions, NONE_SEEN)).toBeUndefined()
  })

  it('tells two windows apart by the folder name when their sessions show the same cut title', () => {
    const inAlpha = session('1', 'Claude Code session manager app')
    const inBeta = session('2', 'Claude Code session manager v2', { workspaceFolder: 'p:\\proj\\beta' })
    const sessions = [inAlpha, inBeta]
    expect(sessionInFront(window(custom('alpha', 'Claude Code session mana\u2026')), sessions, NONE_SEEN)).toBe(inAlpha)
    expect(sessionInFront(window(vscodeDefault('beta', 'Claude Code session mana\u2026')), sessions, NONE_SEEN)).toBe(inBeta)
    // A title that shows neither folder decides nothing.
    expect(sessionInFront(window('Claude Code session mana\u2026'), sessions, NONE_SEEN)).toBeUndefined()
  })

  it('lets a working or seen session with the same title compete, so looking at it acknowledges no other', () => {
    const unseen = session('1', 'Fix the tests')
    const working = session('2', 'Fix the tests', { status: 'working', stoppedAt: undefined })
    expect(sessionInFront(window(custom('alpha', 'Fix the tests')), [unseen, working], NONE_SEEN)).toBeUndefined()
    const elsewhere = { ...working, workspaceFolder: 'p:\\proj\\beta' }
    expect(sessionInFront(window(custom('alpha', 'Fix the tests')), [unseen, elsewhere], NONE_SEEN)).toBe(unseen)
    expect(sessionInFront(window(custom('beta', 'Fix the tests')), [unseen, elsewhere], NONE_SEEN)).toBeUndefined()
  })
})

describe('showsSessionTab', () => {
  const one = session('1', 'CRM master')
  const other = session('2', 'Parser munka')

  it('tells whether the foreground window shows that session’s tab, whatever its state', () => {
    const working = { ...one, status: 'working' as const, stoppedAt: undefined }
    expect(showsSessionTab(window(custom('alpha', 'CRM master')), [working, other], one.sessionId)).toBe(true)
    expect(showsSessionTab(window(custom('alpha', 'Parser munka')), [working, other], one.sessionId)).toBe(false)
  })

  it('says no without a foreground window, in another process, or when two sessions show the same title', () => {
    expect(showsSessionTab(undefined, [one], one.sessionId)).toBe(false)
    expect(showsSessionTab(window(custom('alpha', 'CRM master'), { pid: OTHER_PID }), [one], one.sessionId)).toBe(false)
    const twin = session('3', 'CRM master')
    expect(showsSessionTab(window(custom('alpha', 'CRM master')), [one, twin], one.sessionId)).toBe(false)
  })
})

describe('watchesSeen', () => {
  it('holds while an unseen VS Code finish with a tab title exists', () => {
    const one = session('1', 'CRM master')
    expect(watchesSeen([one], NONE_SEEN)).toBe(true)
    const seen = new Map<string, number>()
    acknowledgeFinish(seen, one, [])
    expect(watchesSeen([one], seen)).toBe(false)
    expect(watchesSeen([session('1', 'CRM master', { entrypoint: CLI_ENTRYPOINT })], NONE_SEEN)).toBe(false)
    expect(watchesSeen([session('1', undefined)], NONE_SEEN)).toBe(false)
    expect(watchesSeen([session('1', 'CRM master', { status: 'working' })], NONE_SEEN)).toBe(false)
    expect(watchesSeen([], NONE_SEEN)).toBe(false)
  })

  it('does not watch or match a session that waits on a session it prompted: no finish to see yet', () => {
    // An invented pipe in the measured shape (design doc "Cross-session messages").
    const pipe = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
    const sender = session('1', 'CRM master', { messagingSocketPath: pipe })
    const recipient = session('2', undefined, { status: 'working', stoppedAt: undefined, activity: { promptedBy: [{ pipe }] } })
    expect(watchesSeen([sender, recipient], NONE_SEEN)).toBe(false)
    expect(sessionInFront(window(custom('alpha', 'CRM master')), [sender, recipient], NONE_SEEN)).toBeUndefined()
    const idleAgain = { ...recipient, status: 'idle' as const }
    expect(watchesSeen([sender, idleAgain], NONE_SEEN)).toBe(true)
    expect(sessionInFront(window(custom('alpha', 'CRM master')), [sender, idleAgain], NONE_SEEN)).toBe(sender)
  })
})

describe('createSeenWatch', () => {
  const one = session('1', 'CRM master')
  const other = session('2', 'Parser munka')
  const sessions = [one, other]
  const onOne = window(custom('alpha', 'CRM master'))
  const onOther = window(custom('alpha', 'Parser munka'))

  it('polls often enough for the dwell', () => {
    expect(SEEN_POLL_MS).toBeLessThan(SEEN_DWELL_MS)
  })

  it('acknowledges once the same match held for the dwell, and only once', () => {
    const watch = createSeenWatch()
    const at = (offset: number, foreground: ForegroundTitle | undefined = onOne): SeenSession | undefined =>
      watch.observe({ foreground, sessions, seen: NONE_SEEN, now: STOPPED_AT + offset })
    expect(at(0)).toBeUndefined()
    expect(at(SEEN_POLL_MS)).toBeUndefined()
    expect(at(SEEN_DWELL_MS - 1)).toBeUndefined()
    expect(at(SEEN_DWELL_MS)).toBe(one)
    // The caller acknowledges it; without that the dwell starts again.
    expect(at(SEEN_DWELL_MS + SEEN_POLL_MS)).toBeUndefined()
  })

  it('starts again on another tab, another window, or no match', () => {
    const watch = createSeenWatch()
    const at = (offset: number, foreground: ForegroundTitle | undefined): SeenSession | undefined =>
      watch.observe({ foreground, sessions, seen: NONE_SEEN, now: offset })
    at(0, onOne)
    expect(at(1000, onOther)).toBeUndefined()
    expect(at(2000, onOne)).toBeUndefined()
    expect(at(3000, { ...onOne, hwnd: 2002 })).toBeUndefined()
    expect(at(4000, window(custom('alpha', 'index.ts')))).toBeUndefined()
    expect(at(4500, onOne)).toBeUndefined()
    expect(at(5500, undefined)).toBeUndefined()
    expect(at(6000, onOne)).toBeUndefined()
    expect(at(6000 + SEEN_DWELL_MS, onOne)).toBe(one)
  })

  it('starts again when the candidate changes, and stops once the finish is seen', () => {
    const watch = createSeenWatch()
    const seen = new Map<string, number>()
    expect(watch.observe({ foreground: onOne, sessions, seen, now: 0 })).toBeUndefined()
    // A second session with the same title arrives in the same window: no single candidate.
    const twin = session('3', 'CRM master')
    expect(watch.observe({ foreground: onOne, sessions: [...sessions, twin], seen, now: 1000 })).toBeUndefined()
    expect(watch.observe({ foreground: onOne, sessions, seen, now: 2000 })).toBeUndefined()
    // A new finish of the same session is another match.
    const later = { ...one, stoppedAt: STOPPED_AT + 1 }
    expect(watch.observe({ foreground: onOne, sessions: [later, other], seen, now: 3000 })).toBeUndefined()
    expect(watch.observe({ foreground: onOne, sessions: [later, other], seen, now: 3000 + SEEN_DWELL_MS })).toBe(later)
    acknowledgeFinish(seen, later, [])
    expect(watch.observe({ foreground: onOne, sessions: [later, other], seen, now: 9000 })).toBeUndefined()
    expect(watch.observe({ foreground: onOne, sessions: [later, other], seen, now: 9000 + SEEN_DWELL_MS })).toBeUndefined()
  })

  it('after a jump to one session, does not count the tab that was in front before (the owner’s bug)', () => {
    // Both finished in one window; the list jumps to `other` while `one`'s tab is still active.
    const watch = createSeenWatch()
    const at = (offset: number, foreground: ForegroundTitle): SeenSession | undefined =>
      watch.observe({ foreground, sessions, seen: NONE_SEEN, now: offset })
    watch.jumpedTo(other.sessionId, 0)
    expect(at(0, onOne)).toBeUndefined()
    expect(at(SEEN_DWELL_MS, onOne)).toBeUndefined()
    expect(at(2 * SEEN_DWELL_MS, onOne)).toBeUndefined()
    // The jump's tab came up: the hold ends, and from now on a tab kept in front counts again.
    at(2500, onOther)
    expect(at(3000, onOne)).toBeUndefined()
    expect(at(3000 + SEEN_DWELL_MS, onOne)).toBe(one)
  })

  it('ends the hold after SEEN_JUMP_HOLD_MS when the jump’s tab never shows', () => {
    const watch = createSeenWatch()
    const at = (offset: number): SeenSession | undefined =>
      watch.observe({ foreground: onOne, sessions, seen: NONE_SEEN, now: offset })
    watch.jumpedTo(other.sessionId, 0)
    expect(at(SEEN_JUMP_HOLD_MS - 1)).toBeUndefined()
    // The hold is over; the dwell starts only now.
    expect(at(SEEN_JUMP_HOLD_MS)).toBeUndefined()
    expect(at(SEEN_JUMP_HOLD_MS + SEEN_DWELL_MS - 1)).toBeUndefined()
    expect(at(SEEN_JUMP_HOLD_MS + SEEN_DWELL_MS)).toBe(one)
  })

  it('drops a dwell already running when a jump starts', () => {
    const watch = createSeenWatch()
    const at = (offset: number, foreground: ForegroundTitle): SeenSession | undefined =>
      watch.observe({ foreground, sessions, seen: NONE_SEEN, now: offset })
    at(0, onOne)
    watch.jumpedTo(other.sessionId, SEEN_DWELL_MS - 1)
    expect(at(SEEN_DWELL_MS, onOne)).toBeUndefined()
  })
})
