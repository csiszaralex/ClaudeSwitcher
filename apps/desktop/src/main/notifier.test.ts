import { describe, expect, it } from 'vitest'
import { createNotifier, type NotifierDecision, type NotifierInput, type NotifierSession, type NotifierState } from './notifier.js'

const BOTH = { notifyOnRequest: true, notifyOnFinish: true }
const REQUESTS_ONLY = { notifyOnRequest: true, notifyOnFinish: false }

const session = (sessionId: string, extra: Partial<NotifierSession> = {}): NotifierSession => ({
  sessionId,
  name: `proj-${sessionId}`,
  status: 'idle',
  entrypoint: 'claude-vscode',
  ...extra,
})

const decision = (id: string, sessionId: string, extra: Partial<NotifierDecision> = {}): NotifierDecision => ({
  id,
  sessionId,
  toolName: 'Bash',
  summary: 'pnpm test',
  released: false,
  ...extra,
})

const state = (sessions: NotifierSession[], decisions: NotifierDecision[] = []): NotifierState => ({ sessions, decisions })

/** One tick with both settings on and the overlay hidden, unless a test says otherwise. */
const tick = (next: NotifierState, rest: Partial<Omit<NotifierInput, 'state'>> = {}): NotifierInput => ({
  state: next,
  settings: BOTH,
  overlayVisible: false,
  excluded: new Set(),
  ...rest,
})

describe('createNotifier: permission requests', () => {
  it('notifies once for a new request, with the session name and the row text', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')])))
    const next = state([session('a')], [decision('d1', 'a')])
    expect(notifier.observe(tick(next))).toEqual([
      { kind: 'request', sessionId: 'a', title: 'proj-a engedélyt kér', body: 'Bash: pnpm test' },
    ])
    expect(notifier.observe(tick(next))).toEqual([])
  })

  it('does not notify for a request already pending at the first tick', () => {
    const notifier = createNotifier()
    const pending = state([session('a')], [decision('d1', 'a')])
    expect(notifier.observe(tick(pending))).toEqual([])
    expect(notifier.observe(tick(pending))).toEqual([])
  })

  it('notifies again for a second request of the same session', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')], [decision('d1', 'a')])))
    const second = notifier.observe(
      tick(state([session('a')], [decision('d1', 'a'), decision('d2', 'a', { summary: 'git status' })])),
    )
    expect(second.map((notice) => notice.body)).toEqual(['Bash: git status'])
  })

  it('does not notify for a released request', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')])))
    expect(notifier.observe(tick(state([session('a')], [decision('d1', 'a', { released: true })])))).toEqual([])
  })

  it('puts the source label first when the source stands out', () => {
    const notifier = createNotifier()
    const headless = session('a', { entrypoint: 'sdk-cli' })
    notifier.observe(tick(state([headless])))
    const [notice] = notifier.observe(tick(state([headless], [decision('d1', 'a')])))
    expect(notice?.body).toBe('claude -p · Bash: pnpm test')
  })

  it('still names a request whose session is not in the list', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([])))
    const [notice] = notifier.observe(tick(state([], [decision('d1', 'gone')])))
    expect(notice).toMatchObject({ sessionId: 'gone', title: 'Egy session engedélyt kér' })
  })

  it('clips a long command to the row text length', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')])))
    const long = decision('d1', 'a', { summary: `cat <<END\n${'x'.repeat(5000)}\nEND` })
    const [notice] = notifier.observe(tick(state([session('a')], [long])))
    expect(notice?.body).toHaveLength(80)
  })

  it('is silenced by its setting, and the request does not notify later when the setting turns on', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')])))
    const pending = state([session('a')], [decision('d1', 'a')])
    expect(notifier.observe(tick(pending, { settings: { notifyOnRequest: false, notifyOnFinish: true } }))).toEqual([])
    expect(notifier.observe(tick(pending))).toEqual([])
  })
})

describe('createNotifier: excluded sessions', () => {
  it('shows no finish toast for an excluded session, and none later when it is brought back', () => {
    const notifier = createNotifier()
    const excluded = new Set(['a'])
    notifier.observe(tick(state([session('a')]), { excluded }))
    const stopped = state([session('a', { stoppedAt: 1000 })])
    expect(notifier.observe(tick(stopped, { excluded }))).toEqual([])
    expect(notifier.observe(tick(stopped))).toEqual([])
    expect(notifier.observe(tick(state([session('a', { stoppedAt: 2000 })])))).toHaveLength(1)
  })

  it('still shows the request toast of an excluded session', () => {
    const notifier = createNotifier()
    const excluded = new Set(['a'])
    notifier.observe(tick(state([session('a')]), { excluded }))
    expect(notifier.observe(tick(state([session('a')], [decision('d1', 'a')]), { excluded })).map((n) => n.kind)).toEqual([
      'request',
    ])
  })
})

describe('createNotifier: finished sessions', () => {
  it('notifies once per new stoppedAt, with the start of the last answer', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')])))
    const stopped = state([session('a', { stoppedAt: 1000, activity: { lastAssistantText: 'Done.\nAll green.' } })])
    expect(notifier.observe(tick(stopped))).toEqual([
      { kind: 'finished', sessionId: 'a', title: 'proj-a végzett', body: 'Done. All green.' },
    ])
    expect(notifier.observe(tick(stopped))).toEqual([])
    const again = state([session('a', { stoppedAt: 2000, activity: { lastAssistantText: 'More.' } })])
    expect(notifier.observe(tick(again))).toHaveLength(1)
  })

  it('names the session by its tab title in both toasts, the name the row shows', () => {
    const notifier = createNotifier()
    const titled = (extra: Partial<NotifierSession> = {}) =>
      session('a', { activity: { tabTitle: 'Számlázás átírása' }, ...extra })
    notifier.observe(tick(state([titled()])))
    const next = state([titled({ stoppedAt: 1000 })], [decision('d1', 'a')])
    expect(notifier.observe(tick(next)).map((notice) => notice.title)).toEqual([
      'Számlázás átírása engedélyt kér',
      'Számlázás átírása végzett',
    ])
  })

  it('has an empty body without an answer text', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')])))
    const [notice] = notifier.observe(tick(state([session('a', { stoppedAt: 5 })])))
    expect(notice?.body).toBe('')
  })

  it('does not notify for a stop that already happened at the first tick', () => {
    const notifier = createNotifier()
    const stopped = state([session('a', { stoppedAt: 1000 })])
    expect(notifier.observe(tick(stopped))).toEqual([])
    expect(notifier.observe(tick(stopped))).toEqual([])
  })

  it('does not count a stoppedAt that comes back unchanged after a subagent, or a gap in the list, as a new finish', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a', { stoppedAt: 1000 })])))
    notifier.observe(tick(state([session('a')])))
    expect(notifier.observe(tick(state([session('a', { stoppedAt: 1000 })])))).toEqual([])
    notifier.observe(tick(state([])))
    expect(notifier.observe(tick(state([session('a', { stoppedAt: 1000 })])))).toEqual([])
  })

  it('waits with the toast while the session waits on a session it prompted, and notifies once when that one is idle', () => {
    // An invented pipe in the measured shape (design doc "Cross-session messages").
    const pipe = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
    const sender = session('a', { stoppedAt: 1000, messagingSocketPath: pipe, activity: { lastAssistantText: 'Átadtam.' } })
    const worker = (status: NotifierSession['status']): NotifierSession =>
      session('w', { status, activity: { promptedBy: [{ pipe, name: 'proj-a' }] } })
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a', { messagingSocketPath: pipe }), worker('working')])))
    expect(notifier.observe(tick(state([sender, worker('working')])))).toEqual([])
    expect(notifier.observe(tick(state([sender, worker('waiting')])))).toEqual([])
    expect(notifier.observe(tick(state([sender, worker('idle')])))).toEqual([
      { kind: 'finished', sessionId: 'a', title: 'proj-a végzett', body: 'Átadtam.' },
    ])
    expect(notifier.observe(tick(state([sender, worker('idle')])))).toEqual([])
    // A finish notified before the wait began does not notify again after it.
    notifier.observe(tick(state([sender, worker('working')])))
    expect(notifier.observe(tick(state([sender, worker('idle')])))).toEqual([])
  })

  it('is off unless its setting is on, and the finish does not notify later when it turns on', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')]), { settings: REQUESTS_ONLY }))
    const stopped = state([session('a', { stoppedAt: 1000 })])
    expect(notifier.observe(tick(stopped, { settings: REQUESTS_ONLY }))).toEqual([])
    expect(notifier.observe(tick(stopped))).toEqual([])
  })
})

describe('createNotifier: the overlay', () => {
  it('shows nothing while the overlay is visible, and nothing later for what arrived then', () => {
    const notifier = createNotifier()
    notifier.observe(tick(state([session('a')])))
    const busy = state([session('a', { stoppedAt: 1000 })], [decision('d1', 'a')])
    expect(notifier.observe(tick(busy, { overlayVisible: true }))).toEqual([])
    expect(notifier.observe(tick(busy))).toEqual([])
  })
})
