import type { LiveSession, SessionActivity, SubagentView } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from './session-store.js'

function live(sessionId: string, over: Partial<LiveSession['record']> = {}): LiveSession {
  return {
    record: {
      pid: 1, sessionId, cwd: 'p:\\proj\\alpha', startedAt: 1,
      name: 'alpha-01', bridgeSessionId: 'session_01x', ...over,
    },
    window: { port: 1000, pid: 900, workspaceFolders: ['p:\\proj\\alpha'] },
  }
}

const noActivity = new Map<string, SessionActivity>()

describe('SessionStore', () => {
  it('projects a snapshot into views', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    const [view] = store.views()
    expect(view!.sessionId).toBe('s1')
    expect(view!.name).toBe('alpha-01')
    expect(view!.windowPid).toBe(900)
    expect(view!.workspaceFolder).toBe('p:\\proj\\alpha')
    expect(view!.bridgeSessionId).toBe('session_01x')
  })

  it('carries the registry entrypoint, so the app can tell an extension session from a CLI one', () => {
    // A tab-fókusz URI csak a VSCode bővítményben futó sessionnek mehet: egy CLI sessionnek
    // a bővítmény egy ÚJ tabot nyitna.
    const store = new SessionStore()
    store.applySnapshot([live('s1', { entrypoint: 'claude-vscode' }), live('s2', { entrypoint: 'cli' }), live('s3')], noActivity)
    const byId = new Map(store.views().map((v) => [v.sessionId, v]))
    expect(byId.get('s1')!.entrypoint).toBe('claude-vscode')
    expect(byId.get('s2')!.entrypoint).toBe('cli')
    expect(byId.get('s3')!.entrypoint).toBeUndefined()
  })

  it('falls back to the directory name when the session has no name', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1', { name: undefined })], noActivity)
    expect(store.views()[0]!.name).toBe('alpha')
  })

  it('reports working while a tool is running', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]))
    expect(store.views()[0]!.status).toBe('working')
  })

  it('reports idle with no tool running', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], new Map([['s1', { lastAssistantText: 'kész' }]]))
    expect(store.views()[0]!.status).toBe('idle')
  })

  it('reports waiting after a permission_prompt notification', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification(
      { sessionId: 's1', cwd: 'c', type: 'permission_prompt', text: 'run pnpm test?' },
      5_000,
    )
    const [view] = store.views()
    expect(view!.status).toBe('waiting')
    expect(view!.waitingSince).toBe(5_000)
    expect(view!.notificationText).toBe('run pnpm test?')
  })

  it('treats agent_needs_input as waiting too', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'agent_needs_input' }, 1)
    expect(store.views()[0]!.status).toBe('waiting')
  })

  it('keeps waiting even when a later snapshot shows a running tool', () => {
    // A snapshot a transcriptből jön és lemaradhat; a hook a mérvadó jelzés.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1)
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]))
    expect(store.views()[0]!.status).toBe('waiting')
  })

  it('clears waiting on a stop lifecycle event', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' })
    const [view] = store.views()
    expect(view!.status).toBe('idle')
    expect(view!.waitingSince).toBeUndefined()
  })

  it('drops a session that has left the snapshot', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2')], noActivity)
    store.applySnapshot([live('s2')], noActivity)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s2'])
  })

  it('sorts waiting sessions first, oldest wait at the top', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2'), live('s3')], noActivity)
    store.applyNotification({ sessionId: 's2', cwd: 'c', type: 'permission_prompt' }, 200)
    store.applyNotification({ sessionId: 's3', cwd: 'c', type: 'permission_prompt' }, 100)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s3', 's2', 's1'])
  })

  it('notifies listeners when state changes', () => {
    const store = new SessionStore()
    const listener = vi.fn()
    store.onChange(listener)
    store.applySnapshot([live('s1')], noActivity)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores notifications for unknown sessions', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 'ghost', cwd: 'c', type: 'permission_prompt' }, 1)
    expect(store.views()).toHaveLength(1)
    expect(store.views()[0]!.status).toBe('idle')
  })

  it('keeps a notification that arrived before its session was scanned', () => {
    // A hook azonnal megérkezik, a session registry-jét viszont 3 másodpercenként
    // olvassuk. Ha a várakozást eldobnánk, amíg a session ismeretlen, a felhasználó egy
    // rá VÁRAKOZÓ sessiont látna idle-ként — pont azt, amiért ez az app létezik.
    const store = new SessionStore()
    store.applySnapshot([], noActivity, 1000)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1000)
    // Amíg a session nincs meg, nem is jelenik meg — a views() a sessionökön iterál.
    expect(store.views()).toHaveLength(0)

    store.applySnapshot([live('s1')], noActivity, 2000)
    expect(store.views()[0]!.status).toBe('waiting')
    expect(store.views()[0]!.waitingSince).toBe(1000)
  })

  it('drops an unmatched notification once the grace period has passed', () => {
    // Enélkül egy soha meg nem jelenő session várakozása örökre a memóriában maradna, és
    // egy újrahasznosított azonosító azonnal „várakozónak" látszana.
    const store = new SessionStore()
    store.applyNotification({ sessionId: 'ghost', cwd: 'c', type: 'permission_prompt' }, 1000)
    store.applySnapshot([], noActivity, 1000 + 11_000)
    store.applySnapshot([live('ghost')], noActivity, 1000 + 11_001)
    expect(store.views()[0]!.status).toBe('idle')
  })

  it('marks a session waiting while a decision is held, before any Notification', () => {
    // A Notification csak ~6 mp függés után jön (mérve); a PermissionRequest azonnal.
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2')], noActivity)
    store.applyPending(new Map([['s2', 500]]), 500)
    const views = store.views()
    const s2 = views.find((v) => v.sessionId === 's2')
    expect(s2?.status).toBe('waiting')
    expect(s2?.waitingSince).toBe(500)
    expect(views[0]?.sessionId).toBe('s2')
  })
})

/** A mért sorrend: PermissionRequest → ~6 mp → Notification permission_prompt → döntés. */
function heldAndNotified(store: SessionStore, sessionId: string, at: number): void {
  store.applyPending(new Map([[sessionId, at]]), at)
  store.applyNotification(
    { sessionId, cwd: 'c', type: 'permission_prompt', text: 'Claude needs your permission to use Bash' },
    at + 6_000,
  )
}

describe('SessionStore — a várakozás vége', () => {
  it('clears the Notification-wait when the app resolves the decision', () => {
    // Mérve (Task 10 A, F): döntés után a sor a Stop-ig „waiting" maradt, a szövege pedig
    // „Claude needs your permission to use Bash"-re váltott.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)

    store.applyPending(new Map(), 9_000, 's1')
    const [view] = store.views()
    expect(view?.status).toBe('idle')
    expect(view?.waitingSince).toBeUndefined()
    expect(view?.notificationText).toBeUndefined()
  })

  it('keeps the Notification-wait when the decision closed without the app (it may be another prompt)', () => {
    // A Stop vagy a PostToolUse külön törli; egy puszta függés-lezárás nem állítja, hogy a
    // natív prompt eltűnt.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)

    store.applyPending(new Map(), 9_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('clears the Notification-wait when a tool of the session has run', () => {
    // A PostToolUse azt jelenti, hogy a prompt megválaszolódott (VSCode, telefon vagy app).
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1_000)

    store.applyToolFinished('s1', 2_000)
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.notificationText).toBeUndefined()
  })

  it('keeps a session waiting through a still-pending or released decision after a tool has run', () => {
    // Egy 590 mp után elengedett döntés a brokerben marad (released), így a pendingSince-ben
    // is: a natív prompt még nyitva van, a session tehát várakozó.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)

    store.applyToolFinished('s1', 591_000)
    const [view] = store.views()
    expect(view?.status).toBe('waiting')
    expect(view?.waitingSince).toBe(1_000)
  })

  it('ignores a permission_prompt that arrives within 10 s of the app\'s decision', () => {
    // A versenyhelyzet: 6 mp-en belüli döntésnél a Notification a döntés UTÁN jön, és
    // különben újra „waiting"-re állítaná a már eldöntött sessiont.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 7_000)
    expect(store.views()[0]?.status).toBe('idle')
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 3_000 + 9_999)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('accepts a permission_prompt again once the 10 s window has passed', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 3_000 + 10_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('lets other waiting Notification types through right after a decision', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'agent_needs_input' }, 4_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('does not suppress a permission_prompt for a session the app did not decide', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2', { name: 'bravo' })], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')

    store.applyNotification({ sessionId: 's2', cwd: 'c', type: 'permission_prompt' }, 4_000)
    expect(store.views().find((v) => v.sessionId === 's2')?.status).toBe('waiting')
  })

  it('clears the Notification-wait in the same change when a request closed by client abort', () => {
    // Mérve (2026-10-25): natív Nem vagy Esc után nem jön hook, csak a tartott kapcsolat bomlik.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)
    const listener = vi.fn()
    store.onChange(listener)

    store.applyPending(new Map(), 9_000, undefined, 's1')
    const [view] = store.views()
    expect(view?.status).toBe('idle')
    expect(view?.notificationText).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not open the late-prompt window after a client abort', () => {
    // A késő Notificationt elnyelő ablak az app döntéséé. Natív válasz után egy új prompt
    // Notificationje valódi várakozás.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    heldAndNotified(store, 's1', 1_000)
    store.applyPending(new Map(), 9_000, undefined, 's1')

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 10_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })

  it('makes an older registry waiting stale after a client abort, like any other closing hook', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1', { status: 'waiting', statusUpdatedAt: 1_500 })], noActivity, 2_000)
    heldAndNotified(store, 's1', 1_000)

    store.applyPending(new Map(), 9_000, undefined, 's1')
    expect(store.views()[0]?.status).toBe('idle')
  })
})

describe('SessionStore — rendezés a várakozás vége szerint', () => {
  function names(store: SessionStore): string[] {
    return store.views().map((v) => v.name)
  }

  it('puts the session that stopped waiting most recently first among the non-waiting ones', () => {
    // A felhasználó kérése (Task 10 B): döntés után a session azonnal a nem-várók tetejére
    // kerüljön, ne név szerint „random a közepére".
    const store = new SessionStore()
    store.applySnapshot(
      [live('a', { name: 'alpha' }), live('b', { name: 'bravo' }), live('c', { name: 'charlie' }),
        live('d', { name: 'delta' })],
      noActivity,
    )
    store.applyNotification({ sessionId: 'c', cwd: 'c', type: 'permission_prompt' }, 100)
    store.applyNotification({ sessionId: 'd', cwd: 'c', type: 'permission_prompt' }, 150)
    store.applyNotification({ sessionId: 'a', cwd: 'c', type: 'permission_prompt' }, 200)
    store.applyToolFinished('c', 300)
    store.applyLifecycle({ sessionId: 'a', cwd: 'c', kind: 'stop' }, 400)

    // Várakozó elöl; utána a 400-kor, majd a 300-kor véget ért; a soha nem várt név szerint.
    expect(names(store)).toEqual(['delta', 'alpha', 'charlie', 'bravo'])
  })

  it('counts the end of a held decision as the end of a wait', () => {
    const store = new SessionStore()
    store.applySnapshot(
      [live('a', { name: 'alpha' }), live('b', { name: 'bravo' }), live('c', { name: 'charlie' })],
      noActivity,
    )
    store.applyNotification({ sessionId: 'a', cwd: 'c', type: 'permission_prompt' }, 100)
    store.applyToolFinished('a', 200)
    store.applyPending(new Map([['c', 300]]), 300)
    store.applyPending(new Map(), 500, 'c')

    expect(names(store)).toEqual(['charlie', 'alpha', 'bravo'])
  })

  it('does not end a wait while the other source still holds it', () => {
    // A Notification törlése nem vet véget a várakozásnak, amíg a döntés függ — és fordítva.
    const store = new SessionStore()
    store.applySnapshot([live('a', { name: 'alpha' }), live('b', { name: 'bravo' })], noActivity)
    heldAndNotified(store, 'b', 300)
    store.applyToolFinished('b', 9_000)
    store.applyNotification({ sessionId: 'a', cwd: 'c', type: 'permission_prompt' }, 9_100)
    store.applyToolFinished('a', 9_200)
    store.applyPending(new Map(), 9_500)

    // A b várakozása 9 500-kor ért véget, nem 9 000-kor: így az a (9 200) mögé nem kerülhet.
    expect(names(store)).toEqual(['bravo', 'alpha'])
  })

  it('orders sessions that never waited by name, as before', () => {
    const store = new SessionStore()
    store.applySnapshot([live('z', { name: 'zulu' }), live('a', { name: 'alpha' })], noActivity)
    expect(names(store)).toEqual(['alpha', 'zulu'])
  })
})

describe('SessionStore — „épp végzett" jelzés (stoppedAt)', () => {
  it('records the time of the last Stop without changing the status values', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)
    expect(store.views()[0]?.stoppedAt).toBe(5_000)
    expect(store.views()[0]?.status).toBe('idle')

    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 8_000)
    expect(store.views()[0]?.stoppedAt).toBe(8_000)
  })

  it('has no stoppedAt for a session that has not stopped', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('clears stoppedAt when a tool starts (PreToolUse)', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2', { name: 'bravo' })], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)
    store.applyLifecycle({ sessionId: 's2', cwd: 'c', kind: 'stop' }, 5_000)

    store.applyToolStarted('s1')
    expect(store.views().find((v) => v.sessionId === 's1')?.stoppedAt).toBeUndefined()
    expect(store.views().find((v) => v.sessionId === 's2')?.stoppedAt).toBe(5_000)
  })

  it('clears stoppedAt when a new decision is held for the session (PermissionRequest)', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)

    store.applyPending(new Map([['s1', 6_000]]), 6_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('clears stoppedAt on a waiting Notification, but not on another type', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'idle_prompt' }, 6_000)
    expect(store.views()[0]?.stoppedAt).toBe(5_000)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'agent_needs_input' }, 7_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('keeps stoppedAt on the late permission_prompt of an already decided request', () => {
    // Az a régi, eldöntött kérés visszhangja, nem új tevékenység.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 2_000, 's1')
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 3_000)

    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 7_000)
    expect(store.views()[0]?.stoppedAt).toBe(3_000)
  })

  it('clears stoppedAt when the snapshot reports a running tool', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)

    store.applySnapshot([live('s1')], new Map([['s1', { lastAssistantText: 'kész' }]]), 6_000)
    expect(store.views()[0]?.stoppedAt).toBe(5_000)
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]), 7_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('forgets stoppedAt when the session ends', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 5_000)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'end' }, 6_000)
    expect(store.views()).toEqual([])

    // Ha a registry még egy körig mutatja, ne „épp végzett"-ként térjen vissza.
    store.applySnapshot([live('s1')], noActivity, 7_000)
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })
})

/** A registry állapotmezői (Claude Code 2.1.296+, mérve): egy várakozó rekord. */
function registryWaiting(sessionId: string, since: number, over: Partial<LiveSession['record']> = {}): LiveSession {
  return live(sessionId, { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: since, ...over })
}

describe('SessionStore — várakozás a registry-ből (app-újraindulás után)', () => {
  it('counts a registry status of waiting as waiting, since statusUpdatedAt', () => {
    // A felhasználó esete: a session már várt, amikor az app újraindult — se PermissionRequest,
    // se Notification nem jön többé, csak a registry tudja.
    const store = new SessionStore()
    store.applySnapshot([live('a', { name: 'alpha' }), registryWaiting('b', 4_000, { name: 'bravo' })], noActivity, 9_000)
    const [first] = store.views()
    expect(first?.sessionId).toBe('b')
    expect(first?.status).toBe('waiting')
    expect(first?.waitingSince).toBe(4_000)
    expect(first?.notificationText).toBeUndefined()
  })

  it('falls back to the old behaviour when the record has no status or no statusUpdatedAt', () => {
    const store = new SessionStore()
    store.applySnapshot(
      [live('a'), live('b', { status: 'waiting', waitingFor: 'permission prompt' }), live('c', { status: 'weird', statusUpdatedAt: 1 })],
      noActivity,
      9_000,
    )
    expect(store.views().map((v) => v.status)).toEqual(['idle', 'idle', 'idle'])
  })

  it('orders registry waits with hook waits by when they started', () => {
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('r', 2_000, { name: 'r' }), live('n', { name: 'n' })], noActivity, 3_000)
    store.applyNotification({ sessionId: 'n', cwd: 'c', type: 'permission_prompt' }, 1_000)
    expect(store.views().map((v) => v.sessionId)).toEqual(['n', 'r'])
  })

  it('prefers the hook source for waitingSince when both know the wait', () => {
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_200)], noActivity, 1_300)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    expect(store.views()[0]?.waitingSince).toBe(1_000)
  })

  it('does not resurrect the wait from a lagging snapshot after the app decided', () => {
    // A hook azonnal jön, a registry-t ~3 mp-enként olvassuk: a döntés utáni első pillanatkép
    // még a régi „waiting"-et mutathatja.
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 1_500)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')
    expect(store.views()[0]?.status).toBe('idle')

    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 4_000)
    expect(store.views()[0]?.status).toBe('idle')
    // Akkor sem, ha a lemaradás a 10 mp-es késő-prompt ablaknál tovább tart.
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 30_000)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('shows a registry wait that started after the app decided, even inside the late-prompt window', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyPending(new Map([['s1', 1_000]]), 1_000)
    store.applyPending(new Map(), 3_000, 's1')
    store.applySnapshot([registryWaiting('s1', 3_500)], noActivity, 5_000)
    expect(store.views()[0]?.status).toBe('waiting')
    expect(store.views()[0]?.waitingSince).toBe(3_500)
  })

  it('clears a registry wait on PostToolUse at once, and a lagging snapshot does not bring it back', () => {
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 1_500)
    store.applyToolFinished('s1', 2_000)
    expect(store.views()[0]?.status).toBe('idle')
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('clears a registry wait on Stop, and a lagging snapshot does not bring it back', () => {
    const store = new SessionStore()
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 1_500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.stoppedAt).toBe(2_000)
  })

  it('records the end of a registry wait for the ordering', () => {
    const store = new SessionStore()
    store.applySnapshot(
      [live('a', { name: 'alpha' }), registryWaiting('z', 1_000, { name: 'zulu' })],
      noActivity,
      1_500,
    )
    // A registry átvált: a várakozás véget ért — a zulu a nem-várók tetejére kerül.
    store.applySnapshot(
      [live('a', { name: 'alpha' }), live('z', { name: 'zulu', status: 'idle', statusUpdatedAt: 2_000 })],
      noActivity,
      4_000,
    )
    expect(store.views().map((v) => v.name)).toEqual(['zulu', 'alpha'])
  })

  it('records the end of a registry wait when a hook clears it', () => {
    const store = new SessionStore()
    store.applySnapshot(
      [live('a', { name: 'alpha' }), registryWaiting('z', 1_000, { name: 'zulu' })],
      noActivity,
      1_500,
    )
    store.applyToolFinished('z', 2_000)
    expect(store.views().map((v) => v.name)).toEqual(['zulu', 'alpha'])
  })

  it('clears stoppedAt for a registry wait newer than the Stop, not for a lagging one', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([registryWaiting('s1', 1_000)], noActivity, 3_000)
    expect(store.views()[0]?.stoppedAt).toBe(2_000)

    store.applySnapshot([registryWaiting('s1', 2_500)], noActivity, 4_000)
    expect(store.views()[0]?.status).toBe('waiting')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })
})

describe('SessionStore — „busy" a registry-ből', () => {
  it('reports working for a registry status of busy, also without a running tool', () => {
    // Gondolkodás vagy szöveg-streamelés közben nincs futó tool — eddig ez tétlennek látszott.
    const store = new SessionStore()
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 1_000 })], noActivity, 2_000)
    expect(store.views()[0]?.status).toBe('working')
  })

  it('ignores busy without statusUpdatedAt', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1', { status: 'busy' })], noActivity, 2_000)
    expect(store.views()[0]?.status).toBe('idle')
  })

  it('does not count a busy older than the last Stop: the session has just finished', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 1_000 })], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.stoppedAt).toBe(2_000)
  })

  it('clears stoppedAt for a busy newer than the Stop: a new turn has begun', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 2_500 })], noActivity, 3_000)
    expect(store.views()[0]?.status).toBe('working')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('keeps a hook wait over a registry busy', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1_000)
    store.applySnapshot([live('s1', { status: 'busy', statusUpdatedAt: 900 })], noActivity, 2_000)
    expect(store.views()[0]?.status).toBe('waiting')
  })
})

describe('SessionStore — subagentek', () => {
  const searching: SubagentView = {
    agentId: 'a1', agentType: 'general-purpose', description: 'Teszt hullám',
    runningTool: 'Grep', toolDetail: 'createPanel', updatedAt: 4_000,
  }
  const thinking: SubagentView = { agentId: 'a2', description: 'Gondolkodó', updatedAt: 3_000 }

  it('carries the active subagents into the view, and nothing when there are none', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2', { name: 'bravo' })], noActivity, 5_000, new Map([['s1', [searching, thinking]]]))
    const byId = new Map(store.views().map((v) => [v.sessionId, v]))
    expect(byId.get('s1')?.subagents).toEqual([searching, thinking])
    expect(byId.get('s2')?.subagents).toBeUndefined()
    expect('subagents' in (byId.get('s2') ?? {})).toBe(false)
  })

  it('reports working while a subagent runs a tool, even after the main Stop', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 1_000)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    expect(store.views()[0]?.status).toBe('idle')

    store.applySnapshot([live('s1')], noActivity, 3_000, new Map([['s1', [searching]]]))
    expect(store.views()[0]?.status).toBe('working')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()
  })

  it('does not show "just finished" while a background subagent is active, even between its tools', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 1_000)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' }, 2_000)
    store.applySnapshot([live('s1')], noActivity, 3_000, new Map([['s1', [thinking]]]))
    expect(store.views()[0]?.status).toBe('idle')
    expect(store.views()[0]?.stoppedAt).toBeUndefined()

    // A subagent tool nélkül nem friss tevékenység: ha eltűnik, a régi Stop ismét látszik.
    store.applySnapshot([live('s1')], noActivity, 4_000)
    expect(store.views()[0]?.stoppedAt).toBe(2_000)
  })

  it('keeps a hook or registry wait over a working subagent', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 500)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1_000)
    store.applySnapshot([live('s1')], noActivity, 2_000, new Map([['s1', [searching]]]))
    expect(store.views()[0]?.status).toBe('waiting')

    const other = new SessionStore()
    other.applySnapshot([registryWaiting('s1', 1_500)], noActivity, 2_000, new Map([['s1', [searching]]]))
    expect(other.views()[0]?.status).toBe('waiting')
  })

  it('forgets the subagents of a session once the snapshot no longer has them', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity, 1_000, new Map([['s1', [searching]]]))
    store.applySnapshot([live('s1')], noActivity, 2_000)
    expect(store.views()[0]?.subagents).toBeUndefined()
    expect(store.views()[0]?.status).toBe('idle')
  })
})
