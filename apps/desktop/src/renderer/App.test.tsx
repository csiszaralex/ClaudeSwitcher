// @vitest-environment happy-dom
import type { AskQuestion } from '@claudeswitcher/core'
import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { pendingRowText } from '../shared/row-text.js'
import { ACTION_BUTTONS } from './decision-actions.js'
import { EXCLUDED_TEXT } from './list-cleanup.js'
import { parseUntil, UNTIL_TEXT } from './until-time.js'
import {
  bashRequest,
  questionRequest,
  renderOverlay,
  type OverlaySetup,
  type RenderedOverlay,
  row,
  rowNames,
  rows,
  searchField,
  selectedName,
  session,
  sessionId,
  START,
} from './test-helpers.js'

/**
 * The overlay's key paths end to end: the real App with the real hooks, the daemon's state
 * delivered as `useDaemonState` gets it, and a fake preload API that records every call
 * (`test-helpers.tsx`). Each test would fail if the wiring of its keys in App's `onKey`, the peek
 * or the decision panel broke, even where the pure helpers behind them still pass.
 */

const LIST = [session(1, 'alpha'), session(2, 'beta'), session(3, 'gamma')]

/** The allow button of a tool request (`ACTION_BUTTONS`). */
const ALLOW = ACTION_BUTTONS.tool[0]!

/** The peek, while it shows. */
function peek(): HTMLElement | null {
  return document.querySelector('section.peek')
}

/** The excluded group's header, while it shows. */
function header(): HTMLElement | null {
  return document.querySelector('li.excluded-header')
}

describe('the list keys', () => {
  it('moves the selection with the arrows and jumps to the selected row on Enter', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma'])
    expect(selectedName()).toBe('alpha')

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}')
    expect(selectedName()).toBe('beta')
    await user.keyboard('{Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(2)]])
  })

  it('jumps on the release of Enter, not on its press, so the session window never gets the key', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard('{Enter>}')
    expect(api.focusSession).not.toHaveBeenCalled()
    await user.keyboard('{/Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)]])
  })

  it('jumps once on the release of a held Enter: the auto-repeats do nothing', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true })
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true })
    expect(api.focusSession).not.toHaveBeenCalled()
    fireEvent.keyUp(document.body, { key: 'Enter' })
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)]])
  })

  it('ignores an Enter release whose press it did not see, and a press the focus left meanwhile', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    fireEvent.keyUp(document.body, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.blur(window)
    fireEvent.keyUp(document.body, { key: 'Enter' })
    expect(api.focusSession).not.toHaveBeenCalled()
  })

  it('jumps to the row selected at the press, and on the release of Tab on a row without a request', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyUp(document.body, { key: 'Enter' })
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)]])

    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(api.focusSession.mock.calls).toHaveLength(1)
    fireEvent.keyUp(document.body, { key: 'Tab' })
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)], [sessionId(2)]])
  })

  it('jumps from the search field and from the peek on the release of Enter too', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: LIST })
    await user.keyboard('/amm{Enter>}')
    expect(api.focusSession).not.toHaveBeenCalled()
    await user.keyboard('{/Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(3)]])

    await user.keyboard('{Escape} ')
    await settle()
    expect(peek()).not.toBeNull()
    await user.keyboard('{Enter>}')
    expect(api.focusSession.mock.calls).toHaveLength(1)
    await user.keyboard('{/Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(3)], [sessionId(3)]])
  })

  it('jumps from a focused jump button on the release of Enter, once, and on a click', async () => {
    const released = { ...bashRequest(1, 'pnpm test'), released: true }
    const { api, user } = await renderOverlay({ sessions: [session(1, 'alpha', { status: 'waiting' })], decisions: [released] })
    const button = screen.getByRole('button', { name: /^Ugrás/ })
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: 'Enter', repeat: true })
    expect(api.focusSession).not.toHaveBeenCalled()
    fireEvent.keyUp(button, { key: 'Enter' })
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)]])
    await user.click(button)
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)], [sessionId(1)]])
    // The press does not click the button either.
    button.focus()
    await user.keyboard('{Enter>}')
    expect(api.focusSession.mock.calls).toHaveLength(2)
    await user.keyboard('{/Enter}')
    expect(api.focusSession.mock.calls).toHaveLength(3)
  })
})

describe('the search', () => {
  it('opens on / with the field focused, filters while typing, and opens the first match on Enter', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard('/')
    expect(searchField()).not.toBeNull()
    expect(document.activeElement).toBe(searchField())

    await user.keyboard('amm')
    expect(rowNames()).toEqual(['gamma'])
    await user.keyboard('{Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(3)]])
  })

  it('finds an excluded session after the others, dimmed and tagged, opens it on Enter, and brings it back on Delete', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: [...LIST, session(4, 'gamma-2')], excluded: [sessionId(3)] })
    await user.keyboard('/gam')
    expect(rowNames()).toEqual(['gamma-2', 'gamma'])
    expect(header()).toBeNull()
    expect(selectedName()).toBe('gamma-2')
    expect(row('gamma').classList.contains('excluded')).toBe(true)
    expect(row('gamma').querySelector('.excluded-tag')?.textContent).toBe(EXCLUDED_TEXT.tag)
    expect(row('gamma-2').querySelector('.excluded-tag')).toBeNull()

    await user.keyboard('{ArrowDown}{Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(3)]])

    // A click takes the cursor out of the field, so Delete is the list's key again.
    await user.click(row('gamma'))
    await user.keyboard('{Delete}')
    expect(api.setExcluded.mock.calls).toEqual([[sessionId(3), false]])
    await settle()
    expect(rowNames()).toEqual(['gamma', 'gamma-2'])
    expect(row('gamma').classList.contains('excluded')).toBe(false)
    expect(selectedName()).toBe('gamma')
  })

  it('selects an excluded match when it is the only one', async () => {
    const { user } = await renderOverlay({ sessions: LIST, excluded: [sessionId(3)] })
    await user.keyboard('/gam')
    expect(rowNames()).toEqual(['gamma'])
    expect(selectedName()).toBe('gamma')
  })

  it('opens on Ctrl+K with the field focused', async () => {
    const { user } = await renderOverlay({ sessions: LIST })
    await user.keyboard('{Control>}k{/Control}')
    expect(searchField()).not.toBeNull()
    expect(document.activeElement).toBe(searchField())
  })

  it('closes on the first Esc with the selection kept, and the second Esc hides the overlay', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard('/gam')
    expect(selectedName()).toBe('gamma')

    await user.keyboard('{Escape}')
    expect(searchField()).toBeNull()
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma'])
    expect(selectedName()).toBe('gamma')
    expect(api.hide).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(api.hide).toHaveBeenCalledTimes(1)
  })

  it('hides the overlay on the release of Esc, not on its press, so the window behind never gets the key', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard('{Escape>}')
    expect(api.hide).not.toHaveBeenCalled()
    await user.keyboard('{/Escape}')
    expect(api.hide).toHaveBeenCalledTimes(1)
  })

  it('ignores an Esc release whose press it did not see, and a press the focus left meanwhile', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    // The press went to another window before the overlay showed.
    fireEvent.keyUp(window, { key: 'Escape' })
    expect(api.hide).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.blur(window)
    fireEvent.keyUp(window, { key: 'Escape' })
    expect(api.hide).not.toHaveBeenCalled()

    // Held: the auto-repeat presses change nothing, the one release hides once.
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Escape', repeat: true })
    fireEvent.keyUp(window, { key: 'Escape' })
    expect(api.hide).toHaveBeenCalledTimes(1)
  })

  it('lets Backspace and Delete edit the query and types / as a character, without touching the list', async () => {
    // The selected row shows a ✓ and is a session: outside the field, Backspace would clear the ✓
    // and Delete would exclude it.
    const finished = session(1, 'alpha', { stoppedAt: Date.parse('2026-11-21T09:59:00.000Z') })
    const { api, user } = await renderOverlay({ sessions: [finished, session(2, 'beta')] })
    expect(selectedName()).toBe('alpha')

    await user.keyboard('/al/')
    expect(searchField()?.value).toBe('al/')
    await user.keyboard('{Backspace}')
    expect(searchField()?.value).toBe('al')
    await user.keyboard('{Home}{Delete}')
    expect(searchField()?.value).toBe('l')

    expect(api.clearFinish).not.toHaveBeenCalled()
    expect(api.setExcluded).not.toHaveBeenCalled()
  })
})

describe('the peek', () => {
  const request = bashRequest(1, 'pnpm test')
  const setup = (): OverlaySetup => ({
    sessions: [session(1, 'alpha'), session(2, 'beta')],
    decisions: [request],
    conversation: {
      ok: true,
      version: 'v1',
      entries: [{ kind: 'prompt', text: 'Futtasd a teszteket.', images: 0, truncated: false }],
    },
  })

  it('opens on Space, shows the pending request, decides nothing, and jumps on Enter', async () => {
    const { api, user, armKeys, settle } = await renderOverlay(setup())
    expect(selectedName()).toBe('alpha')
    // Armed, so on the list A would allow and D would open the deny reason.
    armKeys()

    await user.keyboard(' ')
    await settle()
    expect(api.conversation.mock.calls).toEqual([[sessionId(1)]])
    expect(peek()).not.toBeNull()
    expect(rows()).toEqual([])
    expect(screen.getByText('Futtasd a teszteket.')).toBeTruthy()
    expect(document.querySelector('.peek-request-text')?.textContent).toBe(pendingRowText(request))

    await user.keyboard('ad')
    expect(api.decide).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)]])
  })

  it('goes back to the list on Space or Esc with the peeked row selected', async () => {
    const { api, user, settle } = await renderOverlay(setup())
    await user.keyboard('{ArrowDown}')
    expect(selectedName()).toBe('beta')

    await user.keyboard(' ')
    await settle()
    expect(peek()).not.toBeNull()
    await user.keyboard(' ')
    expect(peek()).toBeNull()
    expect(selectedName()).toBe('beta')

    await user.keyboard(' ')
    await settle()
    expect(peek()).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(peek()).toBeNull()
    expect(selectedName()).toBe('beta')
    expect(api.hide).not.toHaveBeenCalled()
  })

  it('opens on Space from a focused decision panel button without pressing it', async () => {
    const { api, user, armKeys, settle } = await renderOverlay(setup())
    armKeys()
    const allow = screen.getByRole('button', { name: new RegExp(ALLOW.label) })
    // Enabled once the panel re-renders after its arming time.
    await waitFor(() => {
      expect((allow as HTMLButtonElement).disabled).toBe(false)
    })
    allow.focus()
    expect(document.activeElement).toBe(allow)
    // user-event presses a focused button on Space, as a browser does: had App left the key to the
    // button, `decide` would be called.

    await user.keyboard(' ')
    await settle()
    expect(api.conversation.mock.calls).toEqual([[sessionId(1)]])
    expect(peek()).not.toBeNull()
    expect(api.decide).not.toHaveBeenCalled()
  })
})

describe('the cleanup keys', () => {
  it('clears the ✓ of a finished row on Backspace, and does nothing on a working row', async () => {
    const finished = session(1, 'alpha', { stoppedAt: Date.parse('2026-11-21T09:59:00.000Z') })
    const working = session(2, 'beta', { status: 'working', activity: { runningTool: 'Bash' } })
    const { api, user, settle } = await renderOverlay({ sessions: [finished, working] })
    expect(rowNames()).toEqual(['alpha', 'beta'])
    expect(row('alpha').querySelector('.marker')?.textContent).toBe('✓')

    await user.keyboard('{ArrowDown}{Backspace}')
    expect(selectedName()).toBe('beta')
    expect(api.clearFinish).not.toHaveBeenCalled()

    await user.keyboard('{ArrowUp}{Backspace}')
    expect(api.clearFinish.mock.calls).toEqual([[sessionId(1)]])
    await settle()
    expect(row('alpha').querySelector('.marker')?.textContent).not.toBe('✓')
  })

  it('moves a row into the closed excluded group on Delete, opens the group on Enter, and brings the row back on Delete', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: LIST })
    await user.keyboard('{ArrowDown}{ArrowDown}{Delete}')
    expect(api.setExcluded.mock.calls).toEqual([[sessionId(3), true]])
    await settle()

    expect(header()?.textContent).toContain(EXCLUDED_TEXT.group(1))
    expect(header()?.textContent).toContain('▸')
    expect(rowNames()).toEqual(['alpha', 'beta'])

    await user.keyboard('{ArrowDown}')
    expect(header()?.classList.contains('selected')).toBe(true)
    await user.keyboard('{Enter}')
    expect(header()?.textContent).toContain('▾')
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma'])
    expect(row('gamma').classList.contains('excluded')).toBe(true)
    expect(api.focusSession).not.toHaveBeenCalled()

    await user.keyboard('{ArrowDown}')
    expect(selectedName()).toBe('gamma')
    await user.keyboard('{Delete}')
    expect(api.setExcluded.mock.calls).toEqual([
      [sessionId(3), true],
      [sessionId(3), false],
    ])
    await settle()
    expect(header()).toBeNull()
    expect(row('gamma').classList.contains('excluded')).toBe(false)
  })

  it('opens the closed group with → on its header, takes ← from its row to the header, and closes it with ←', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST, excluded: [sessionId(3)] })
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(header()?.classList.contains('selected')).toBe(true)
    await user.keyboard('{ArrowRight}')
    expect(header()?.textContent).toContain('▾')

    await user.keyboard('{ArrowDown}')
    expect(selectedName()).toBe('gamma')
    await user.keyboard('{ArrowLeft}')
    expect(header()?.classList.contains('selected')).toBe(true)
    expect(header()?.textContent).toContain('▾')
    await user.keyboard('{ArrowLeft}')
    expect(header()?.textContent).toContain('▸')

    // ← on the closed header and → on the open one do nothing.
    await user.keyboard('{ArrowLeft}{ArrowRight}{ArrowRight}')
    expect(header()?.textContent).toContain('▾')
    expect(api.focusSession).not.toHaveBeenCalled()
  })

  it('acts once on a held ←: from a row of the open group to the header, without closing it', async () => {
    const { user } = await renderOverlay({ sessions: LIST, excluded: [sessionId(3)] })
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}{ArrowDown}')
    expect(selectedName()).toBe('gamma')
    await user.keyboard('{ArrowLeft>4/}')
    expect(header()?.classList.contains('selected')).toBe(true)
    expect(header()?.textContent).toContain('▾')
  })

  it('moves a session that came back because it started running into the list at the push, with its tag until the next push', async () => {
    const { pushExcluded, settle } = await renderOverlay({ sessions: LIST, excluded: [sessionId(3)] })
    expect(rowNames()).toEqual(['alpha', 'beta'])

    pushExcluded({ excluded: [], returned: [sessionId(3)], due: [] })
    await settle()
    expect(header()).toBeNull()
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma'])
    expect(row('gamma').classList.contains('excluded')).toBe(false)
    expect(row('gamma').querySelector('.excluded-tag')?.textContent).toBe(EXCLUDED_TEXT.returnedTag)

    // The first jump ends the mark in the main process, which pushes again.
    pushExcluded({ excluded: [], returned: [], due: [] })
    await settle()
    expect(row('gamma').querySelector('.excluded-tag')).toBeNull()
  })

  it('tags a session excluded while running in the group alone, and beside the kizárt tag in the search', async () => {
    const { user } = await renderOverlay({ sessions: LIST, excludedWhileRunning: [sessionId(3)] })
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    const tags = (): string[] => [...row('gamma').querySelectorAll('.excluded-tag')].map((tag) => tag.textContent)
    expect(tags()).toEqual([EXCLUDED_TEXT.whileRunningTag])

    await user.keyboard('/gam')
    expect(tags()).toEqual([EXCLUDED_TEXT.tag, EXCLUDED_TEXT.whileRunningTag])
  })

  it('excludes a working session as excluded while running: its row carries that tag in the group', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: [session(1, 'alpha'), session(2, 'beta', { status: 'working' })] })
    // The working session is the first row.
    expect(selectedName()).toBe('beta')
    await user.keyboard('{Delete}')
    expect(api.setExcluded.mock.calls).toEqual([[sessionId(2), true]])
    await settle()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(row('beta').querySelector('.excluded-tag')?.textContent).toBe(EXCLUDED_TEXT.whileRunningTag)
  })

  it('keeps an excluded session with a pending request in the list, with the tag, out of the group', async () => {
    await renderOverlay({
      sessions: [session(1, 'alpha'), session(2, 'beta')],
      decisions: [bashRequest(1, 'pnpm test')],
      excluded: [sessionId(1)],
    })
    expect(rowNames()).toEqual(['alpha', 'beta'])
    expect(row('alpha').querySelector('.excluded-tag')?.textContent).toBe(EXCLUDED_TEXT.tag)
    expect(row('alpha').classList.contains('excluded')).toBe(false)
    expect(header()).toBeNull()
  })
})

describe('the decision panel letters', () => {
  const request = bashRequest(1, 'pnpm test')

  it('allows on A only once the panel is armed', async () => {
    const { api, user, armKeys } = await renderOverlay({ sessions: [session(1, 'alpha')], decisions: [request] })
    await user.keyboard('a')
    expect(api.decide).not.toHaveBeenCalled()

    armKeys()
    await user.keyboard('a')
    expect(api.decide.mock.calls).toEqual([[request.id, { type: 'allow' }]])
  })

  it('opens the deny reason on D, where the letters are text, and denies with the reason on Enter', async () => {
    const { api, user, armKeys } = await renderOverlay({ sessions: [session(1, 'alpha')], decisions: [request] })
    armKeys()
    await user.keyboard('d')
    const reason = document.activeElement as HTMLInputElement
    expect(reason.tagName).toBe('INPUT')
    expect(api.decide).not.toHaveBeenCalled()

    await user.keyboard('ad')
    expect(reason.value).toBe('ad')
    expect(api.decide).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    expect(api.decide.mock.calls).toEqual([[request.id, { type: 'deny', message: 'ad' }]])
  })
})

describe('the selection after a decision', () => {
  /** The request of gamma that arrives while beta is selected and pulls the selection. */
  const pulling = { ...bashRequest(3, 'pnpm test'), id: 'req-pull' }
  const waiting = (n: number, name: string) => session(n, name, { status: 'waiting' })

  /** The overlay with beta selected, then gamma's request arriving: the selection is pulled to gamma. */
  async function pulled(more: PendingDecisionView[] = []): Promise<RenderedOverlay> {
    const overlay = await renderOverlay({ sessions: LIST })
    await overlay.user.keyboard('{ArrowDown}')
    expect(selectedName()).toBe('beta')
    overlay.sendState({ sessions: [LIST[0]!, LIST[1]!, waiting(3, 'gamma')], decisions: [pulling, ...more] })
    expect(selectedName()).toBe('gamma')
    overlay.armKeys()
    return overlay
  }

  /** Allows the selected request on A and lets the step after it land. */
  async function allow(overlay: RenderedOverlay): Promise<void> {
    await overlay.user.keyboard('a')
    await overlay.settle()
  }

  it('goes back to the row a request pulled the selection from, once its request is decided', async () => {
    const overlay = await pulled()
    await allow(overlay)
    expect(overlay.api.decide.mock.calls).toEqual([[pulling.id, { type: 'allow' }]])
    expect(selectedName()).toBe('beta')
    expect(overlay.api.hide).not.toHaveBeenCalled()
  })

  it('does not go back when the user moved the selection himself meanwhile', async () => {
    const overlay = await pulled()
    await overlay.user.keyboard('{ArrowDown}{ArrowUp}')
    expect(selectedName()).toBe('gamma')
    // The panel mounted again with the selection: its letters arm again.
    overlay.armKeys()
    await allow(overlay)
    expect(overlay.api.hide).toHaveBeenCalledTimes(1)
  })

  it('moves to another waiting request instead', async () => {
    const overlay = await pulled()
    // It arrives after the pull, so the selection stays on gamma, which holds a request.
    overlay.sendState({ sessions: [waiting(1, 'alpha'), LIST[1]!, waiting(3, 'gamma')], decisions: [pulling, bashRequest(1, 'pnpm lint')] })
    expect(selectedName()).toBe('gamma')
    await allow(overlay)
    expect(selectedName()).toBe('alpha')
  })

  it('does not go back when the remembered row is gone', async () => {
    const overlay = await pulled()
    overlay.sendState({ sessions: [LIST[0]!, waiting(3, 'gamma')], decisions: [pulling] })
    await allow(overlay)
    expect(overlay.api.hide).toHaveBeenCalledTimes(1)
  })

  it('stays while the decided session has another request to decide, and goes back after that one', async () => {
    const sibling = { ...bashRequest(3, 'pnpm build'), id: 'req-sibling' }
    const overlay = await pulled([sibling])
    await allow(overlay)
    expect(selectedName()).toBe('gamma')
    overlay.sendState({ sessions: [LIST[0]!, LIST[1]!, waiting(3, 'gamma')], decisions: [sibling] })
    overlay.armKeys()
    await allow(overlay)
    expect(overlay.api.decide.mock.calls.map(([id]) => id)).toEqual([pulling.id, sibling.id])
    expect(selectedName()).toBe('beta')
  })

  it('does not go back after the overlay appeared again', async () => {
    const overlay = await pulled()
    await overlay.show()
    expect(selectedName()).toBe('gamma')
    overlay.armKeys()
    await allow(overlay)
    expect(overlay.api.hide).toHaveBeenCalledTimes(1)
  })

  describe('after the last decision', () => {
    const request = bashRequest(1, 'pnpm test')
    const finished = session(2, 'beta', { stoppedAt: Date.parse('2026-11-21T09:59:00.000Z') })

    it('hides with the setting on', async () => {
      const overlay = await renderOverlay({ sessions: [waiting(1, 'alpha'), finished], decisions: [request] })
      overlay.armKeys()
      await allow(overlay)
      expect(overlay.api.hide).toHaveBeenCalledTimes(1)
    })

    it('moves to the first green ✓ with the setting off', async () => {
      const overlay = await renderOverlay({
        sessions: [waiting(1, 'alpha'), session(3, 'gamma'), finished],
        decisions: [request],
      })
      overlay.api.settings.mockResolvedValue({ hideAfterLastDecision: false })
      expect(selectedName()).toBe('alpha')
      overlay.armKeys()
      await allow(overlay)
      expect(selectedName()).toBe('beta')
      expect(overlay.api.hide).not.toHaveBeenCalled()
    })

    it('stays on the decided row with the setting off and no green ✓', async () => {
      const overlay = await renderOverlay({ sessions: [waiting(1, 'alpha'), session(3, 'gamma')], decisions: [request] })
      overlay.api.settings.mockResolvedValue({ hideAfterLastDecision: false })
      overlay.armKeys()
      await allow(overlay)
      expect(selectedName()).toBe('alpha')
      expect(overlay.api.hide).not.toHaveBeenCalled()
    })
  })
})

describe('the state and the showing', () => {
  it('keeps the selection on its session when a live state from the daemon reorders the list', async () => {
    const { user, sendState } = await renderOverlay({ sessions: LIST })
    await user.keyboard('{ArrowDown}')
    expect(selectedName()).toBe('beta')

    const finished = session(3, 'gamma', { stoppedAt: Date.parse('2026-11-21T09:59:00.000Z') })
    sendState({ sessions: [LIST[0]!, LIST[1]!, finished], decisions: [] })
    expect(rowNames()).toEqual(['gamma', 'alpha', 'beta'])
    expect(selectedName()).toBe('beta')
  })

  it('closes the search, the peek and the excluded group when the overlay appears again', async () => {
    const { user, show, settle } = await renderOverlay({ sessions: LIST, excluded: [sessionId(3)] })
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(header()?.textContent).toContain('▾')
    await user.keyboard('/')
    expect(searchField()).not.toBeNull()

    await show()
    expect(searchField()).toBeNull()
    expect(header()?.textContent).toContain('▸')

    await user.keyboard(' ')
    await settle()
    expect(peek()).not.toBeNull()
    await show()
    expect(peek()).toBeNull()
    expect(rowNames()).toEqual(['alpha', 'beta'])
  })
})

describe('the question form', () => {
  const branch: AskQuestion = {
    question: 'Melyik ágon dolgozzunk?',
    header: 'Ág',
    multiSelect: false,
    options: [{ label: 'main', description: 'A fő ág' }, { label: 'fejlesztés' }, { label: 'kísérlet' }],
  }
  const tests: AskQuestion = {
    question: 'Mely teszteket futtassuk?',
    header: 'Tesztek',
    multiSelect: true,
    options: [{ label: 'egység' }, { label: 'komponens' }, { label: 'végpontok' }],
  }
  const name: AskQuestion = { question: 'Mi legyen a neve?', multiSelect: false, options: [{ label: 'alfa' }, { label: 'béta' }] }
  const request = questionRequest(1, [branch, tests, name])
  const setup = (): OverlaySetup => ({ sessions: [session(1, 'alpha'), session(2, 'beta')], decisions: [request] })

  function optionBox(): HTMLElement {
    const box = document.querySelector<HTMLElement>('.question-options')
    if (box === null) throw new Error('no option box')
    return box
  }
  function otherField(): HTMLInputElement {
    const field = document.querySelector<HTMLInputElement>('input.other')
    if (field === null) throw new Error('no free text field')
    return field
  }
  const shownQuestion = (): string | null | undefined => document.querySelector('.question-text')?.textContent
  const cursorLabel = (): string | null | undefined => document.querySelector('.option.cursor .option-label')?.textContent
  /** The checked options' labels of the shown question, with their number ("2. fejlesztés"). */
  const checked = (): string[] =>
    [...document.querySelectorAll('.option[aria-checked="true"] .option-label')].map((label) => label.textContent)
  /** The tabs' texts: the mark (✓ answered, ○ not yet) and the label. */
  const tabTexts = (): string[] => screen.getAllByRole('tab').map((tab) => tab.textContent)
  const activeTab = (): string | null | undefined => document.querySelector('.question-tab.active')?.textContent

  it('labels the tabs by header, else by number, and enters the form on Tab, onto the first option', async () => {
    const { user } = await renderOverlay(setup())
    expect(tabTexts()).toEqual(['○ Ág', '○ Tesztek', '○ 3. kérdés'])
    expect(shownQuestion()).toBe(branch.question)
    // Only the open question shows.
    expect(screen.queryByText(tests.question)).toBeNull()

    await user.keyboard('{Tab}')
    expect(document.activeElement).toBe(optionBox())
    expect(cursorLabel()).toBe('1. main')
  })

  it('steps the options with the arrows without moving the list, and a single-choice pick moves on', async () => {
    const { api, user } = await renderOverlay(setup())
    expect(selectedName()).toBe('alpha')
    await user.keyboard('{Tab}{ArrowDown}{ArrowDown}{ArrowUp}')
    expect(cursorLabel()).toBe('2. fejlesztés')
    expect(selectedName()).toBe('alpha')

    await user.keyboard('{Enter}')
    expect(tabTexts()[0]).toBe('✓ Ág')
    expect(shownQuestion()).toBe(tests.question)
    expect(activeTab()).toBe('○ Tesztek')
    expect(document.activeElement).toBe(optionBox())
    expect(api.focusSession).not.toHaveBeenCalled()
  })

  it('picks by digit, toggles a multiple-choice question with Space, and moves on from it on Enter', async () => {
    const { user } = await renderOverlay(setup())
    await user.keyboard('{Tab}3')
    expect(tabTexts()[0]).toBe('✓ Ág')
    expect(shownQuestion()).toBe(tests.question)

    await user.keyboard(' {ArrowDown}{ArrowDown} ')
    expect(checked()).toEqual(['1. egység', '3. végpontok'])
    await user.keyboard(' ')
    expect(checked()).toEqual(['1. egység'])
    expect(shownQuestion()).toBe(tests.question)

    await user.keyboard('3{Enter}')
    expect(tabTexts()[1]).toBe('✓ Tesztek')
    expect(shownQuestion()).toBe(name.question)
  })

  it('goes back with ← to an answered question, changes its answer, and → opens the next one', async () => {
    const { user } = await renderOverlay(setup())
    await user.keyboard('{Tab}1')
    expect(shownQuestion()).toBe(tests.question)

    await user.keyboard('{ArrowLeft}')
    expect(shownQuestion()).toBe(branch.question)
    expect(checked()).toEqual(['1. main'])
    // The cursor starts on the chosen option.
    expect(cursorLabel()).toBe('1. main')
    await user.keyboard('{ArrowDown}{ArrowDown} ')
    // The next unanswered one opens.
    expect(shownQuestion()).toBe(tests.question)
    await user.keyboard('{ArrowLeft}')
    expect(checked()).toEqual(['3. kísérlet'])

    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(shownQuestion()).toBe(name.question)
    await user.keyboard('{ArrowRight}')
    expect(shownQuestion()).toBe(name.question)
  })

  it('puts the cursor into the free text field with ↓, keeps the side arrows there, and moves on on Enter', async () => {
    const { user } = await renderOverlay(setup())
    await user.keyboard('{Tab}{ArrowRight}{ArrowRight}')
    expect(shownQuestion()).toBe(name.question)

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(document.activeElement).toBe(otherField())
    await user.keyboard('gamm{ArrowLeft}a1 ')
    expect(otherField().value).toBe('gama1 m')
    expect(shownQuestion()).toBe(name.question)

    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(optionBox())
    expect(cursorLabel()).toBe('2. béta')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(tabTexts()[2]).toBe('✓ 3. kérdés')
    // The first unanswered question after the last one, around the end.
    expect(shownQuestion()).toBe(branch.question)
  })

  it('sends the exact answers on the Enter that answers the last open question, not before', async () => {
    const { api, user } = await renderOverlay(setup())
    await user.keyboard('{Tab}2')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(api.decide).not.toHaveBeenCalled()

    // Enter on the multiple choice moves on while a question is still open: no send yet.
    await user.keyboard('31{Enter}')
    expect(api.decide).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}{ArrowDown}gamma{Enter}')
    expect(api.decide.mock.calls).toEqual([
      [
        request.id,
        {
          type: 'answer',
          answers: {
            [branch.question]: 'fejlesztés',
            [tests.question]: 'egység, végpontok',
            [name.question]: 'gamma',
          },
        },
      ],
    ])
  })

  it('sends nothing on a digit or Space that completes the answers: then Enter or Ctrl+Enter sends', async () => {
    const { api, user } = await renderOverlay(setup())
    // Digits answer all three; the last digit completes the form but does not send.
    await user.keyboard('{Tab}2')
    await user.keyboard('1{Enter}1')
    expect(tabTexts()).toEqual(['✓ Ág', '✓ Tesztek', '✓ 3. kérdés'])
    expect(api.decide).not.toHaveBeenCalled()

    // Going back to change an answer with a digit does not send either.
    await user.keyboard('{ArrowLeft}{ArrowLeft}3')
    expect(api.decide).not.toHaveBeenCalled()

    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(api.decide.mock.calls).toEqual([
      [request.id, { type: 'answer', answers: { [branch.question]: 'kísérlet', [tests.question]: 'egység', [name.question]: 'alfa' } }],
    ])
  })

  it('answers one question only on a held Enter', async () => {
    const { user } = await renderOverlay(setup())
    await user.keyboard('{Tab}')
    fireEvent.keyDown(optionBox(), { key: 'Enter' })
    fireEvent.keyDown(optionBox(), { key: 'Enter', repeat: true })
    fireEvent.keyDown(optionBox(), { key: 'Enter', repeat: true })
    expect(tabTexts()).toEqual(['✓ Ág', '○ Tesztek', '○ 3. kérdés'])
    expect(shownQuestion()).toBe(tests.question)
    expect(checked()).toEqual([])
  })

  it('goes back to the list on Esc with the answers kept, and the list keys work again', async () => {
    const { api, user } = await renderOverlay(setup())
    await user.keyboard('{Tab}2')
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(document.body)
    expect(api.hide).not.toHaveBeenCalled()
    expect(tabTexts()[0]).toBe('✓ Ág')

    await user.keyboard('{Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)]])

    // Back in, the form is where it was left.
    await user.keyboard('{Tab}')
    expect(shownQuestion()).toBe(tests.question)
  })

  it('takes the focus out of the form when the overlay appears again, so the first keys are the list keys', async () => {
    const { api, user, show } = await renderOverlay(setup())
    await user.keyboard('{Tab}')
    expect(document.activeElement).toBe(optionBox())

    await show()
    expect(document.activeElement).toBe(document.body)
    await user.keyboard('{Enter}')
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)]])
    expect(tabTexts()[0]).toBe('○ Ág')
  })

  it("keeps the list's keys from acting while the focus is in the form", async () => {
    const { api, user, settle } = await renderOverlay(setup())
    await user.keyboard('{Tab}')
    // Enter and Space pick in the form; on the list they would jump and peek.
    await user.keyboard('{Enter}{Delete}{Backspace}/ {Control>}k{/Control}')
    await settle()
    expect(api.focusSession).not.toHaveBeenCalled()
    expect(api.setExcluded).not.toHaveBeenCalled()
    expect(api.clearFinish).not.toHaveBeenCalled()
    expect(api.conversation).not.toHaveBeenCalled()
    expect(api.hide).not.toHaveBeenCalled()
    expect(searchField()).toBeNull()
    expect(rowNames()).toEqual(['alpha', 'beta'])
    expect(selectedName()).toBe('alpha')
  })

  it('still answers and sends by mouse, without taking the focus from the list', async () => {
    const { api, user } = await renderOverlay(setup())
    await user.click(screen.getByText('kísérlet'))
    expect(document.activeElement).toBe(document.body)
    expect(shownQuestion()).toBe(tests.question)
    await user.click(screen.getByText('komponens'))
    await user.click(screen.getByRole('tab', { name: /3\. kérdés/ }))
    await user.click(otherField())
    await user.keyboard('delta')

    await user.click(screen.getByRole('button', { name: /Válasz elküldése/ }))
    expect(api.decide.mock.calls).toEqual([
      [
        request.id,
        {
          type: 'answer',
          answers: { [branch.question]: 'kísérlet', [tests.question]: 'komponens', [name.question]: 'delta' },
        },
      ],
    ])
  })
})

describe('the auto-accept hold (Shift+A)', () => {
  const request = bashRequest(1, 'pnpm test')

  /**
   * Fakes the timers too, so the 3 s hold need not be waited out; `Date` stays at the time the
   * overlay had. Only after the render: the kit's own `settle` runs on real timers.
   */
  function fakeClock(): void {
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(now)
  }

  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  /** Lets the IPC reply of a completed hold land, without timers. */
  async function flush(): Promise<void> {
    for (let round = 0; round < 3; round += 1) await act(() => Promise.resolve())
  }

  const down = (repeat = false): void => {
    fireEvent.keyDown(document.body, { key: 'A', shiftKey: true, repeat })
  }
  const up = (key = 'A'): void => {
    fireEvent.keyUp(document.body, { key, shiftKey: key !== 'Shift' })
  }

  const summaryOf = (name: string): string => row(name).querySelector('.summary')?.textContent ?? ''
  const tagOf = (name: string): string | undefined => row(name).querySelector('.auto-tag')?.textContent ?? undefined

  it('turns the selected session on after 3 s, with the seconds counting down, and the row turns green with its tag', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    fakeClock()
    down()
    expect(summaryOf('alpha')).toBe('Automatikus engedélyezés bekapcsolása: még 3 mp, tartsd lenyomva')
    advance(1_200)
    expect(summaryOf('alpha')).toContain('még 2 mp')
    advance(1_799)
    expect(api.setAutoAccept).not.toHaveBeenCalled()
    advance(1)
    expect(api.setAutoAccept.mock.calls).toEqual([[sessionId(1), true]])

    await flush()
    expect(row('alpha').classList.contains('auto-accept')).toBe(true)
    expect(tagOf('alpha')).toBe('auto 0')
    expect(row('beta').classList.contains('auto-accept')).toBe(false)
    expect(tagOf('beta')).toBeUndefined()
    expect(summaryOf('alpha')).not.toContain('Automatikus')
  })

  it('turns a session in the mode off at once, without a hold or a countdown, and a held key does nothing more', async () => {
    const { api } = await renderOverlay({ sessions: LIST, autoAccept: [{ sessionId: sessionId(1), allowed: 2 }] })
    expect(row('alpha').classList.contains('auto-accept')).toBe(true)
    expect(tagOf('alpha')).toBe('auto 2')
    fakeClock()
    down()
    expect(api.setAutoAccept.mock.calls).toEqual([[sessionId(1), false]])
    expect(summaryOf('alpha')).not.toContain('Automatikus')
    await flush()
    expect(row('alpha').classList.contains('auto-accept')).toBe(false)
    // Still held: the repeats neither turn it off again nor start the hold that would turn it on.
    for (let step = 0; step < 8; step += 1) {
      advance(500)
      down(true)
    }
    expect(summaryOf('alpha')).not.toContain('Automatikus')
    expect(api.setAutoAccept.mock.calls).toEqual([[sessionId(1), false]])
  })

  it('needs the full hold again to turn it back on after an off', async () => {
    const { api } = await renderOverlay({ sessions: LIST, autoAccept: [{ sessionId: sessionId(1), allowed: 2 }] })
    fakeClock()
    down()
    up()
    await flush()
    down()
    advance(2_999)
    expect(api.setAutoAccept.mock.calls).toEqual([[sessionId(1), false]])
    advance(1)
    expect(api.setAutoAccept.mock.calls).toEqual([
      [sessionId(1), false],
      [sessionId(1), true],
    ])
  })

  it('never decides the selected request when it turns the mode off', async () => {
    const { api, armKeys } = await renderOverlay({
      sessions: [session(1, 'alpha')],
      decisions: [request],
      autoAccept: [{ sessionId: sessionId(1), allowed: 0 }],
    })
    armKeys()
    down()
    expect(api.setAutoAccept.mock.calls).toEqual([[sessionId(1), false]])
    expect(api.decide).not.toHaveBeenCalled()
  })

  it('does nothing when the A, the Shift or the window is let go early', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    fakeClock()
    const releases = [
      () => {
        up('A')
      },
      () => {
        up('Shift')
      },
      () => {
        fireEvent.blur(window)
      },
    ]
    for (const release of releases) {
      down()
      advance(2_000)
      release()
      expect(summaryOf('alpha')).not.toContain('Automatikus')
      advance(5_000)
    }
    expect(api.setAutoAccept).not.toHaveBeenCalled()
  })

  it('counts from the first keydown: the auto-repeat of the held key does not restart it', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    fakeClock()
    down()
    for (let step = 0; step < 5; step += 1) {
      advance(500)
      down(true)
    }
    expect(api.setAutoAccept).not.toHaveBeenCalled()
    advance(500)
    expect(api.setAutoAccept.mock.calls).toEqual([[sessionId(1), true]])
  })

  it('ends when the selection leaves the row', async () => {
    const { api } = await renderOverlay({ sessions: LIST })
    fakeClock()
    down()
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    advance(3_000)
    expect(api.setAutoAccept).not.toHaveBeenCalled()
  })

  it('does not start in a text field or with Ctrl or Alt', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard('/')
    expect(searchField()).not.toBeNull()
    fakeClock()
    fireEvent.keyDown(searchField()!, { key: 'A', shiftKey: true })
    advance(3_000)
    fireEvent.keyDown(document.body, { key: 'A', shiftKey: true, ctrlKey: true })
    advance(3_000)
    fireEvent.keyDown(document.body, { key: 'A', shiftKey: true, altKey: true })
    advance(3_000)
    expect(api.setAutoAccept).not.toHaveBeenCalled()
  })

  it('never allows the selected request, held or not, while a plain a still does', async () => {
    const { api, armKeys } = await renderOverlay({ sessions: [session(1, 'alpha')], decisions: [request] })
    armKeys()
    fakeClock()
    down()
    for (let step = 0; step < 6; step += 1) {
      advance(500)
      down(true)
    }
    up()
    expect(api.setAutoAccept.mock.calls).toEqual([[sessionId(1), true]])
    expect(api.decide).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'a' })
    expect(api.decide.mock.calls).toEqual([[request.id, { type: 'allow' }]])
  })

  it('shows a count the main process pushes while the overlay is up', async () => {
    const { pushAutoAccept } = await renderOverlay({ sessions: LIST, autoAccept: [{ sessionId: sessionId(2), allowed: 0 }] })
    expect(tagOf('beta')).toBe('auto 0')
    pushAutoAccept([{ sessionId: sessionId(2), allowed: 3 }])
    await flush()
    expect(tagOf('beta')).toBe('auto 3')
    pushAutoAccept([])
    await flush()
    expect(tagOf('beta')).toBeUndefined()
  })
})

describe('the timed exclusion (Shift+Delete)', () => {
  const HOUR = 3_600_000

  /** The time bar, while it shows. */
  const bar = (): HTMLElement | null => document.querySelector('li.until-bar')
  const field = (): HTMLInputElement | null => document.querySelector('input.until-field')
  const preview = (): string => document.querySelector('.until-preview')?.textContent ?? ''
  const presets = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('button.until-preset')]
  const tags = (name: string): string[] => [...row(name).querySelectorAll('.excluded-tag')].map((tag) => tag.textContent)
  const shiftDelete = '{Shift>}{Delete}{/Shift}'
  /** What `parseUntil` gives for the phrase now: the time the bar must send. */
  const timeOf = (text: string): number => {
    const parsed = parseUntil(text, Date.now(), undefined)
    if (parsed.kind !== 'time') throw new Error(`no time for ${text}`)
    return parsed.until
  }

  it('opens the bar under the selected row with the focus in its field, and excludes nothing by itself', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard(`{ArrowDown}${shiftDelete}`)
    expect(bar()).not.toBeNull()
    expect(bar()?.previousElementSibling).toBe(row('beta'))
    expect(document.activeElement).toBe(field())
    expect(presets().map((button) => button.textContent)).toEqual([UNTIL_TEXT.oneHour, UNTIL_TEXT.tomorrowMorning, UNTIL_TEXT.mondayMorning])
    // An empty field previews what Enter takes: the first preset.
    expect(preview()).toBe(UNTIL_TEXT.preview(Date.now() + HOUR, Date.now()))
    expect(api.setExcluded).not.toHaveBeenCalled()
    expect(api.setExcludedUntil).not.toHaveBeenCalled()
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('takes the first preset on Enter in the empty field: the row moves into the group with its until tag', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: LIST })
    await user.keyboard(`{ArrowDown}${shiftDelete}{Enter}`)
    expect(api.setExcludedUntil.mock.calls).toEqual([[sessionId(2), Date.now() + HOUR]])
    expect(api.setExcluded).not.toHaveBeenCalled()
    await settle()
    expect(bar()).toBeNull()
    expect(rowNames()).toEqual(['alpha', 'gamma'])
    expect(selectedName()).toBe('gamma')
    await user.click(header() ?? document.body)
    expect(tags('beta')).toEqual([EXCLUDED_TEXT.untilTag(Date.now() + HOUR, Date.now())])
  })

  it('excludes until the phrase typed, previewed in absolute form', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: LIST })
    await user.keyboard(shiftDelete)
    await user.keyboard('csütörtök reggel')
    const until = timeOf('csütörtök reggel')
    expect(preview()).toBe(UNTIL_TEXT.preview(until, Date.now()))
    await user.keyboard('{Enter}')
    expect(api.setExcludedUntil.mock.calls).toEqual([[sessionId(1), until]])
    await settle()
    expect(rowNames()).toEqual(['beta', 'gamma'])
  })

  it('says Nem értem for a phrase it does not take, and then Enter does nothing', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard(shiftDelete)
    await user.keyboard('jövő héten valamikor{Enter}')
    expect(preview()).toBe(UNTIL_TEXT.unknown)
    expect(api.setExcludedUntil).not.toHaveBeenCalled()
    expect(bar()).not.toBeNull()
    // A time already gone does nothing either.
    await user.clear(field() ?? document.body)
    await user.keyboard('ma 0:00{Enter}')
    expect(preview()).toBe(UNTIL_TEXT.past)
    expect(api.setExcludedUntil).not.toHaveBeenCalled()
  })

  it('confirms a preset by Tab and Enter, by ← and →, and by a click', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: LIST })
    await user.keyboard(`${shiftDelete}{Tab}{Tab}`)
    expect(document.activeElement).toBe(presets()[1])
    expect(preview()).toBe(UNTIL_TEXT.preview(timeOf('holnap reggel'), Date.now()))
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowLeft}{Enter}')
    expect(api.setExcludedUntil.mock.calls).toEqual([[sessionId(1), timeOf('hétfő reggel')]])
    await settle()
    expect(selectedName()).toBe('beta')

    await user.keyboard(shiftDelete)
    // Shift+Tab from the field goes around to the last preset.
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement).toBe(presets()[2])
    await user.click(presets()[0] ?? document.body)
    expect(api.setExcludedUntil.mock.calls.at(-1)).toEqual([sessionId(2), Date.now() + HOUR])
  })

  it('keeps every key in the bar: a waiting request decides nothing, and the list does not move', async () => {
    const request = bashRequest(1, 'pnpm test')
    const { api, user, armKeys } = await renderOverlay({ sessions: LIST, decisions: [request] })
    armKeys()
    expect(selectedName()).toBe('alpha')
    await user.keyboard(shiftDelete)

    // Typed in the field: the letters, Space, Shift+A, Delete, Backspace and the arrows are the field's.
    await user.keyboard('ads A{ArrowDown}{ArrowUp}{ArrowLeft}{Backspace}{Delete}')
    expect(field()?.value.startsWith('ads')).toBe(true)
    // With a preset focused, and the letters' pause after typing over.
    await user.keyboard('{Tab}')
    armKeys()
    await user.keyboard('ads{ArrowDown}{ArrowUp}{Delete}{Backspace}{Shift>}A{/Shift}')
    expect(document.activeElement).toBe(presets()[0])

    expect(api.decide).not.toHaveBeenCalled()
    expect(api.setExcluded).not.toHaveBeenCalled()
    expect(api.setExcludedUntil).not.toHaveBeenCalled()
    expect(api.clearFinish).not.toHaveBeenCalled()
    expect(api.focusSession).not.toHaveBeenCalled()
    expect(document.querySelector('section.peek')).toBeNull()
    expect(selectedName()).toBe('alpha')
  })

  it('closes the bar alone on Esc: its release does not hide the overlay, and the next Esc does', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard(shiftDelete)
    await user.keyboard('{Escape>}')
    expect(bar()).toBeNull()
    await user.keyboard('{/Escape}')
    expect(api.hide).not.toHaveBeenCalled()
    expect(api.setExcludedUntil).not.toHaveBeenCalled()
    expect(selectedName()).toBe('alpha')

    // From a preset too.
    await user.keyboard(`${shiftDelete}{Tab}{Escape}`)
    expect(bar()).toBeNull()
    expect(api.hide).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(api.hide).toHaveBeenCalledTimes(1)
  })

  it('leaves plain Delete as it was: it excludes at once, without a time and without the bar', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard('{Delete}')
    expect(api.setExcluded.mock.calls).toEqual([[sessionId(1), true]])
    expect(api.setExcludedUntil).not.toHaveBeenCalled()
    expect(bar()).toBeNull()
  })

  it('stays a text edit in the search field', async () => {
    const { api, user } = await renderOverlay({ sessions: LIST })
    await user.keyboard(`/alp{Home}${shiftDelete}`)
    expect(searchField()?.value).toBe('lp')
    expect(bar()).toBeNull()
    expect(api.setExcludedUntil).not.toHaveBeenCalled()
  })

  it('does nothing on the group header, and closes when the overlay appears again', async () => {
    const { user, show } = await renderOverlay({ sessions: LIST, excluded: [sessionId(3)] })
    await user.keyboard(`{ArrowDown}{ArrowDown}${shiftDelete}`)
    expect(header()?.classList.contains('selected')).toBe(true)
    expect(bar()).toBeNull()

    await user.keyboard(`{ArrowUp}${shiftDelete}`)
    expect(bar()).not.toBeNull()
    await show()
    expect(bar()).toBeNull()
  })

  it('gives a row of the group a new time: it keeps its place and its selection, and shows the new time', async () => {
    const later = START + 5 * 86_400_000
    const { api, user, settle } = await renderOverlay({ sessions: LIST, excludedUntil: [{ sessionId: sessionId(3), until: later }] })
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}{ArrowDown}')
    expect(selectedName()).toBe('gamma')
    expect(tags('gamma')).toEqual([EXCLUDED_TEXT.untilTag(later, Date.now())])

    await user.keyboard(`${shiftDelete}holnap 9{Enter}`)
    const until = timeOf('holnap 9')
    expect(api.setExcludedUntil.mock.calls).toEqual([[sessionId(3), until]])
    await settle()
    expect(selectedName()).toBe('gamma')
    expect(row('gamma').classList.contains('excluded')).toBe(true)
    expect(tags('gamma')).toEqual([EXCLUDED_TEXT.untilTag(until, Date.now())])
  })

  it('shows the until tag on a waiting excluded row and on a search match', async () => {
    const later = START + 2 * HOUR
    const { user } = await renderOverlay({
      sessions: LIST,
      decisions: [bashRequest(1, 'pnpm test')],
      excludedUntil: [{ sessionId: sessionId(1), until: later }, { sessionId: sessionId(3), until: later }],
    })
    const until = EXCLUDED_TEXT.untilTag(later, Date.now())
    expect(tags('alpha')).toEqual([EXCLUDED_TEXT.tag, until])
    await user.keyboard('/gam')
    expect(tags('gamma')).toEqual([EXCLUDED_TEXT.tag, until])
  })

  it('brings a row back at the push with the teendő tag, quietly in its usual place', async () => {
    const until = START + HOUR
    const { pushExcluded, settle } = await renderOverlay({ sessions: LIST, excludedUntil: [{ sessionId: sessionId(3), until }] })
    expect(rowNames()).toEqual(['alpha', 'beta'])
    pushExcluded({ excluded: [], returned: [], due: [{ sessionId: sessionId(3), until }] })
    await settle()
    expect(header()).toBeNull()
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma'])
    expect(tags('gamma')).toEqual([EXCLUDED_TEXT.dueTag])
    expect(row('gamma').querySelector('.excluded-tag')?.getAttribute('title')).toBe(EXCLUDED_TEXT.dueTitle(until, Date.now()))
  })

  it('takes the teendő tag off with Backspace, and the ✓ with it where there is one', async () => {
    const finished = session(2, 'beta', { stoppedAt: START - 120_000 })
    const due = [
      { sessionId: sessionId(1), until: START - 60_000 },
      { sessionId: sessionId(2), until: START - 60_000 },
    ]
    const { api, user, settle } = await renderOverlay({ sessions: [LIST[0]!, finished], due })
    // The ✓ row first.
    expect(rowNames()).toEqual(['beta', 'alpha'])
    await user.keyboard('{Backspace}')
    expect(api.clearFinish.mock.calls).toEqual([[sessionId(2)]])
    expect(api.clearDue.mock.calls).toEqual([[sessionId(2)]])
    await settle()
    expect(tags('beta')).toEqual([])

    await user.click(row('alpha'))
    expect(selectedName()).toBe('alpha')
    await user.keyboard('{Backspace}')
    expect(api.clearDue.mock.calls.at(-1)).toEqual([sessionId(1)])
    expect(api.clearFinish).toHaveBeenCalledTimes(1)
    await settle()
    expect(tags('alpha')).toEqual([])
  })

  it('ends the teendő mark on Delete, which excludes the row as before', async () => {
    const { api, user, settle } = await renderOverlay({ sessions: LIST, due: [{ sessionId: sessionId(1), until: START - 60_000 }] })
    expect(tags('alpha')).toEqual([EXCLUDED_TEXT.dueTag])
    await user.keyboard('{Delete}')
    expect(api.setExcluded.mock.calls).toEqual([[sessionId(1), true]])
    await settle()
    await user.click(header() ?? document.body)
    expect(tags('alpha')).toEqual([])
  })
})
