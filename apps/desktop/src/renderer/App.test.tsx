// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { pendingRowText } from '../shared/row-text.js'
import { ACTION_BUTTONS } from './decision-actions.js'
import { EXCLUDED_TEXT } from './list-cleanup.js'
import {
  bashRequest,
  renderOverlay,
  type OverlaySetup,
  row,
  rowNames,
  rows,
  searchField,
  selectedName,
  session,
  sessionId,
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

  it('jumps again on every auto-repeated Enter of a held key', async () => {
    // Today App's `onKey` does not look at `repeat` for Enter: each repeat asks for the jump again,
    // and the main process drops a jump asked while one runs (`main/index.ts` `jumpInFlight`).
    const { api } = await renderOverlay({ sessions: LIST })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true })
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true })
    expect(api.focusSession.mock.calls).toEqual([[sessionId(1)], [sessionId(1)], [sessionId(1)]])
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
