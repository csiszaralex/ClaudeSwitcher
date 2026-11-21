// @vitest-environment happy-dom
import type { AskQuestion } from '@claudeswitcher/core'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { pendingRowText } from '../shared/row-text.js'
import { ACTION_BUTTONS } from './decision-actions.js'
import { EXCLUDED_TEXT } from './list-cleanup.js'
import {
  bashRequest,
  questionRequest,
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

  it('sends the exact answers on Ctrl+Enter only once every question is answered', async () => {
    const { api, user } = await renderOverlay(setup())
    await user.keyboard('{Tab}2')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(api.decide).not.toHaveBeenCalled()

    await user.keyboard('31{Enter}{ArrowDown}{ArrowDown}')
    await user.keyboard('gamma{Enter}')
    await user.keyboard('{Control>}{Enter}{/Control}')
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
