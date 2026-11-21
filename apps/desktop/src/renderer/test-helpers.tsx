/**
 * The shared kit of the overlay's component tests (`*.test.tsx` in this folder, which run in
 * happy-dom): a fake `window.claudeswitcher` that implements the whole preload API and records
 * every call, a fake WebSocket that stands in for the daemon's hub, the builders of the invented
 * sessions and requests, and `renderOverlay`, which renders the real `App` the way `main.tsx`
 * `Root` does, so a test states only its data. Only tests import it: the renderer's own type check
 * (`tsconfig.web.json`) excludes it, the tests' one (`tsconfig.web.test.json`) checks it, and no
 * entry point of the bundle imports it.
 */
import type { SessionView } from '@claudeswitcher/core'
import { DAEMON_PROTOCOL } from '@claudeswitcher/core/browser'
import type { DaemonState, PendingDecisionView } from '@claudeswitcher/daemon'
import { act, cleanup, render } from '@testing-library/react'
import { userEvent, type UserEvent } from '@testing-library/user-event'
import type { JSX } from 'react'
import { onTestFinished, vi, type Mock } from 'vitest'
import type { ClaudeSwitcherApi } from '../preload/api.js'
import type { ConversationReply } from '../shared/overlay-channels.js'
import { clearFinish, seenFinishesReply, type SeenFinish } from '../shared/session-finished.js'
import { App } from './App.js'
import { SHORTCUT_ARM_MS, TYPING_COOLDOWN_MS } from './key-guard.js'
import { useDaemonState } from './useDaemonState.js'
import { useExcludedSessions } from './useExcludedSessions.js'
import { useSeenFinishes } from './useSeenFinishes.js'

/** The fake API: every method of `ClaudeSwitcherApi` as a vitest mock, so a test checks its calls. */
type FakeApi = { [K in keyof ClaudeSwitcherApi]: Mock<ClaudeSwitcherApi[K]> }

/** The data a test starts from. Everything is optional; the defaults are an empty list and no reply of note. */
export interface OverlaySetup {
  sessions?: SessionView[]
  decisions?: PendingDecisionView[]
  /** The sessions already excluded from the list (`main/excluded-sessions.ts`). */
  excluded?: readonly string[]
  /** The peek's reply (`OVERLAY_CHANNELS.conversation`); an empty history by default. */
  conversation?: ConversationReply
}

/** The fixed start of the overlay's clock: only `Date` is faked, so the key letters arm when a test says so. */
const START = Date.parse('2026-11-21T10:00:00.000Z')

/**
 * A stand-in for the daemon's WebSocket. `useDaemonState` opens it with `new WebSocket(url)`, so the
 * fake is installed as the global; it opens on the next macrotask, as a real socket would, and a
 * test pushes a live state through it with `sendState`.
 */
class FakeSocket {
  static latest: FakeSocket | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.latest = this
    setTimeout(() => {
      this.onopen?.()
    }, 0)
  }

  close(): void {
    // The hook closes the socket only on unmount; nothing to tell it then.
  }
}

/**
 * The fake preload API. It answers like the main process: the state over IPC, the seen finishes
 * and the excluded sessions in their wire formats, a clear and a Delete applied with the main
 * process's rules (only a listed session; `shared/session-finished.ts` `clearFinish`), and every
 * decision accepted.
 */
function fakeApi(
  setup: OverlaySetup,
  state: DaemonState,
  shown: Set<(preferred: string | undefined) => void>,
): FakeApi {
  const seen = new Map<string, SeenFinish>()
  const excluded = new Set(setup.excluded ?? [])
  const listed = (sessionId: string): SessionView | undefined => state.sessions.find((s) => s.sessionId === sessionId)
  return {
    connection: vi.fn(() => Promise.resolve({ port: 47_999, token: 'a'.repeat(64) })),
    state: vi.fn(() => Promise.resolve(structuredClone(state))),
    finishesSeen: vi.fn(() => Promise.resolve(seenFinishesReply(seen))),
    clearFinish: vi.fn((sessionId: string) => {
      const view = listed(sessionId)
      if (view !== undefined) clearFinish(seen, view, state.sessions)
      return Promise.resolve(seenFinishesReply(seen))
    }),
    excludedSessions: vi.fn(() => Promise.resolve([...excluded])),
    setExcluded: vi.fn((sessionId: string, exclude: boolean) => {
      if (exclude && listed(sessionId) !== undefined) excluded.add(sessionId)
      if (!exclude) excluded.delete(sessionId)
      return Promise.resolve([...excluded])
    }),
    focusSession: vi.fn(() => Promise.resolve(true)),
    conversation: vi.fn(() => Promise.resolve(setup.conversation ?? { ok: true, version: 'v1', entries: [] })),
    hide: vi.fn(() => Promise.resolve()),
    decide: vi.fn(() => Promise.resolve({ ok: true })),
    settings: vi.fn(() => Promise.resolve({ hideAfterLastDecision: true })),
    appVersion: vi.fn(() => Promise.resolve('0.0.0-test')),
    onShown: vi.fn((callback: (preferred: string | undefined) => void) => {
      shown.add(callback)
      return () => {
        shown.delete(callback)
      }
    }),
  }
}

/** `main.tsx` `Root` without its error boundaries: the daemon state, the seen finishes and the excluded sessions, then App. */
function Overlay(): JSX.Element {
  const overlay = useDaemonState()
  const [seenFinishes, trackSeen] = useSeenFinishes()
  const [excluded, trackExcluded] = useExcludedSessions()
  return (
    <App overlay={overlay} seenFinishes={seenFinishes} trackSeen={trackSeen} excluded={excluded} trackExcluded={trackExcluded} />
  )
}

/** Lets the pending timers of zero delay and the promise chains behind them run, inside `act`. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

export interface RenderedOverlay {
  api: FakeApi
  user: UserEvent
  /** The overlay appears again (`OVERLAY_CHANNELS.shown`), without a session to select. */
  show: () => Promise<void>
  /** A live state message from the daemon, as the hub sends it; the fake main process sees the new state too. */
  sendState: (next: DaemonState) => void
  /** Moves the clock past the key letters' arming and the pause after typing (`key-guard.ts`). */
  armKeys: () => void
  /** Lets the replies in flight land. */
  settle: () => Promise<void>
}

/**
 * Renders the overlay with `setup` as the daemon's state and the main process's data, waits until
 * the state has arrived the way `useDaemonState` gets it (the socket opens, then the state over
 * IPC), and cleans everything up when the test finishes.
 */
export async function renderOverlay(setup: OverlaySetup = {}): Promise<RenderedOverlay> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  const shown = new Set<(preferred: string | undefined) => void>()
  // The daemon's state, which the fake main process reads too; a live message replaces it.
  const state: DaemonState = { sessions: setup.sessions ?? [], decisions: setup.decisions ?? [] }
  const api = fakeApi(setup, state, shown)
  window.claudeswitcher = api
  vi.stubGlobal('WebSocket', FakeSocket)
  onTestFinished(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    FakeSocket.latest = undefined
  })

  render(<Overlay />)
  await settle()
  if (api.state.mock.calls.length === 0) throw new Error('the overlay did not ask for the state')

  return {
    api,
    user: userEvent.setup(),
    show: async () => {
      act(() => {
        for (const callback of shown) callback(undefined)
      })
      await settle()
    },
    sendState: (next) => {
      const socket = FakeSocket.latest
      if (socket === undefined) throw new Error('no socket is open')
      state.sessions = next.sessions
      state.decisions = next.decisions
      act(() => {
        socket.onmessage?.({ data: JSON.stringify({ type: 'state', protocol: DAEMON_PROTOCOL, payload: next }) })
      })
    },
    armKeys: () => {
      vi.setSystemTime(Date.now() + SHORTCUT_ARM_MS + TYPING_COOLDOWN_MS)
    },
    settle,
  }
}

/** An invented session id, a well-formed UUID; `n` tells them apart. */
export function sessionId(n: number): string {
  return `6f1c2a3e-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** An idle session named `name` in an invented folder; `overrides` sets the rest. */
export function session(n: number, name: string, overrides: Partial<SessionView> = {}): SessionView {
  return { sessionId: sessionId(n), name, cwd: `p:\\proj\\${name}`, status: 'idle', activity: {}, ...overrides }
}

/** A held Bash request of the session, readable and not released, with an invented command. */
export function bashRequest(n: number, command: string): PendingDecisionView {
  return {
    id: `req-${String(n)}`,
    createdAt: START - 60_000,
    released: false,
    sessionId: sessionId(n),
    cwd: `p:\\proj\\${String(n)}`,
    toolName: 'Bash',
    toolInput: { command },
    kind: 'tool',
    summary: command,
    suggestedRules: [],
    questions: [],
    readable: true,
  }
}

/** The list's session rows, in order. */
export function rows(): HTMLLIElement[] {
  return [...document.querySelectorAll<HTMLLIElement>('li.session')]
}

/** The shown names of the list's rows, in order. */
export function rowNames(): string[] {
  return rows().map((row) => row.querySelector('.name-text')?.textContent ?? '')
}

/** The row whose shown name is `name`; throws when there is none. */
export function row(name: string): HTMLLIElement {
  const found = rows().find((candidate) => candidate.querySelector('.name-text')?.textContent === name)
  if (found === undefined) throw new Error(`no row named ${name}`)
  return found
}

/** The shown name of the selected row, or `undefined` when no row is selected. */
export function selectedName(): string | undefined {
  return document.querySelector('li.session.selected .name-text')?.textContent ?? undefined
}

/** The search field, or `null` while the search is closed. */
export function searchField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input.search-field')
}
