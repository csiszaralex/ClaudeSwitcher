import { exec, execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { SessionView } from '@claudeswitcher/core'
import {
  CLI_EXEC_OPTIONS,
  FOREGROUND_POLL_ATTEMPTS,
  FOREGROUND_POLL_INTERVAL_MS,
  TAB_FOCUS_SETTLE_MS,
  bringToFront,
  codeCliCommand,
  countMainWindows,
  findMainWindow,
  focusWith,
  foregroundWindow,
  isFastFocusAvailable,
  isSafeForCli,
  quoteForCli,
  scanWindowsForPid,
  tabFocusUri,
  type FocusApi,
  type FocusOutcome,
  type WindowScanner,
} from './focus-window.js'

/** A fake desktop: the given windows in Z order, linked into a chain. */
function fakeScanner(
  windows: Array<{ hwnd: number; pid: number; visible?: boolean; titled?: boolean }>,
): WindowScanner {
  const byHwnd = new Map(windows.map((w) => [w.hwnd, w]))
  const order = windows.map((w) => w.hwnd)
  return {
    GetTopWindow: () => order[0] ?? 0,
    GetWindow: (hWnd: number) => {
      const index = order.indexOf(hWnd)
      return index === -1 ? 0 : (order[index + 1] ?? 0)
    },
    GetWindowThreadProcessId: (hWnd: number, pid: [number]) => {
      pid[0] = byHwnd.get(hWnd)?.pid ?? 0
      return 0
    },
    IsWindowVisible: (hWnd: number) => (byHwnd.get(hWnd)?.visible === false ? 0 : 1),
    GetWindowTextLengthW: (hWnd: number) => (byHwnd.get(hWnd)?.titled === false ? 0 : 5),
  }
}

const onWindows = process.platform === 'win32'

/** The pid of a running VSCode process with a visible main window, or undefined. */
function runningVSCodeWindowPid(): number | undefined {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process Code -ErrorAction SilentlyContinue | ' +
        'Where-Object { $_.MainWindowHandle -ne 0 } | ' +
        'Select-Object -First 1 -ExpandProperty Id',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  ).trim()
  const pid = Number.parseInt(out, 10)
  return Number.isNaN(pid) ? undefined : pid
}

describe('findMainWindow', () => {
  it.skipIf(!onWindows)('loads the koffi bindings and returns 0 for a pid owning no window', () => {
    // Proves that the user32 bindings load with the declared signatures and that the walk loop
    // stops. NOTE: on its own it does NOT prove that the out parameter of GetWindowThreadProcessId
    // works: if the pid were never written, this test would still get 0 and pass. The third test
    // covers that.
    expect(findMainWindow(999_999_998)).toBe(0)
  })

  it.skipIf(!onWindows)('returns a plain number rather than a BigInt', () => {
    // With a BigInt HWND `hwnd !== 0` would never be false.
    expect(typeof findMainWindow(999_999_998)).toBe('number')
  })

  it.skipIf(!onWindows)('finds the main window of a running VSCode instance', (ctx) => {
    // This is the test that actually proves the out parameter: a value above zero is only possible
    // if GetWindowThreadProcessId wrote the pid and it matched. It does NOT bring a window to the
    // front, it only finds it.
    //
    // It uses `countMainWindows`, not `findMainWindow`: for a process owning several windows the
    // latter correctly returns 0, which could not be told apart from an out parameter that does not
    // work, so the test would fail to prove exactly what it exists for.
    const pid = runningVSCodeWindowPid()
    if (pid === undefined) {
      // A visible skip, not a silent pass: it has to show in the run's output.
      ctx.skip()
      return
    }
    expect(countMainWindows(pid)).toBeGreaterThan(0)
    // The helper starts a real PowerShell (see `runningVSCodeWindowPid`): slow under load.
  }, 40_000)
})

describe('scanWindowsForPid', () => {
  it('returns the one window a process owns', () => {
    const api = fakeScanner([
      { hwnd: 10, pid: 111 },
      { hwnd: 20, pid: 222 },
    ])
    expect(scanWindowsForPid(api, 222)).toEqual([20])
  })

  it('reports more than one window, so an ambiguous pid can be detected', () => {
    // This is the real case: a VSCode main process owns all its windows, and one lock pid belongs to
    // several workspace folders. Then the pid does not identify a window.
    const api = fakeScanner([
      { hwnd: 10, pid: 777 },
      { hwnd: 20, pid: 999 },
      { hwnd: 30, pid: 777 },
    ])
    expect(scanWindowsForPid(api, 777)).toHaveLength(2)
  })

  it('ignores invisible and untitled windows', () => {
    const api = fakeScanner([
      { hwnd: 10, pid: 555, visible: false },
      { hwnd: 20, pid: 555, titled: false },
      { hwnd: 30, pid: 555 },
    ])
    expect(scanWindowsForPid(api, 555)).toEqual([30])
  })

  it('returns nothing for a pid that owns no window', () => {
    expect(scanWindowsForPid(fakeScanner([{ hwnd: 10, pid: 111 }]), 222)).toEqual([])
  })
})

describe('foregroundWindow', () => {
  it.skipIf(!onWindows)('reads the foreground handle through loaded bindings, without changing it', () => {
    // `bringToFront` checks with the same GetForegroundWindow call that the focus change really
    // happened. Without isFastFocusAvailable this test would pass even if the bindings never
    // loaded: foregroundWindow then returns 0, which is a finite number too. The test only reads; it
    // does not demand a value above zero, because on a locked screen or during a focus change
    // Windows may rightly return 0.
    expect(isFastFocusAvailable()).toBe(true)
    const hwnd = foregroundWindow()
    expect(typeof hwnd).toBe('number')
    expect(Number.isFinite(hwnd)).toBe(true)
  })
})

describe('quoteForCli', () => {
  /** Sends the quoted token through the real cmd.exe + CRT argv chain and reads it back. */
  function roundTrip(folder: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        `node -e "process.stdout.write(process.argv[1])" ${quoteForCli(folder)}`,
        { windowsHide: true },
        (error, stdout) => {
          if (error) reject(error)
          else resolve(stdout)
        },
      )
    })
  }

  it.skipIf(!onWindows)('survives the real CRT argv parser unchanged', async () => {
    // It does not assert the shape of the string but that the real parser returns the same folder.
    // The plain quoting used before the fix broke four of these.
    const folders = [
      'C:\\work\\normal-folder',
      'C:\\',
      'C:\\work\\trailing\\',
      'C:\\work\\double\\\\',
      '\\\\server\\share\\',
      'C:\\My Projects\\R&D (old)',
    ]
    for (const folder of folders) {
      expect(await roundTrip(folder)).toBe(folder)
    }
    // Six real `node` starts in a row: on a loaded or freshly installed machine (virus scanner, cold
    // cache) the default 5 s was too little during the full run; alone it took 1.2 s (measured
    // 2026-10-30).
  }, 20_000)
})

const SESSION_ID = '0b5c1d7e-3f2a-4c8b-9e6d-1a2b3c4d5e6f'

/** A session running in the VSCode extension, with a known window: the happy case of the tab focus. */
function extensionView(over: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: SESSION_ID,
    name: 'alpha',
    cwd: 'p:\\proj\\alpha\\sub',
    status: 'waiting',
    activity: {},
    windowPid: 900,
    workspaceFolder: 'p:\\proj\\alpha',
    entrypoint: 'claude-vscode',
    ...over,
  }
}

/** Fake focus steps: they record what was asked of them and bring nothing forward. */
function fakeSteps(result: { pid: boolean; cli: boolean }): {
  steps: Parameters<typeof focusWith>[1]
  pidCalls: number[]
  cliCalls: string[]
} {
  const pidCalls: number[] = []
  const cliCalls: string[] = []
  return {
    steps: {
      byPid: (pid) => {
        pidCalls.push(pid)
        return Promise.resolve(result.pid)
      },
      byCli: (folder) => {
        cliCalls.push(folder)
        return Promise.resolve(result.cli)
      },
    },
    pidCalls,
    cliCalls,
  }
}

describe('focusWith', () => {
  it('reports the fast pid path when it brought the window forward, without running the CLI', async () => {
    const fake = fakeSteps({ pid: true, cli: true })
    expect(await focusWith(extensionView(), fake.steps)).toBe<FocusOutcome>('pid')
    expect(fake.pidCalls).toEqual([900])
    expect(fake.cliCalls).toEqual([])
  })

  it('reports the workspace path when the CLI resolved the lock file folder', async () => {
    const fake = fakeSteps({ pid: false, cli: true })
    expect(await focusWith(extensionView(), fake.steps)).toBe<FocusOutcome>('workspace')
    expect(fake.cliCalls).toEqual(['p:\\proj\\alpha'])
  })

  it('reports the cwd path when no window is known, so the tab URI can refuse it', async () => {
    const fake = fakeSteps({ pid: false, cli: true })
    const view = extensionView({ windowPid: undefined, workspaceFolder: undefined })
    expect(await focusWith(view, fake.steps)).toBe<FocusOutcome>('cwd')
    expect(fake.pidCalls).toEqual([])
    expect(fake.cliCalls).toEqual(['p:\\proj\\alpha\\sub'])
  })

  it('reports the cwd path when the pid is known but the folder is not and the fast path failed', async () => {
    // This is the gap behind the `windowPid !== undefined || workspaceFolder !== undefined`
    // condition: the pid is known, but the fast path failed, so `code` got the cwd, which may have
    // opened a new window. The outcome reports this as `cwd`, not as a "success".
    const fake = fakeSteps({ pid: false, cli: true })
    const view = extensionView({ workspaceFolder: undefined })
    expect(await focusWith(view, fake.steps)).toBe<FocusOutcome>('cwd')
  })

  it('reports failure when neither path brought a window forward', async () => {
    const fake = fakeSteps({ pid: false, cli: false })
    expect(await focusWith(extensionView(), fake.steps)).toBe<FocusOutcome>('failed')
  })

  it('never runs the CLI for a session that is known not to run in the VS Code extension', async () => {
    // A terminal or SDK session has no VS Code window: `code <folder>` would only open a new window
    // for it.
    for (const entrypoint of ['cli', 'sdk-ts', 'Claude-VSCode']) {
      const fake = fakeSteps({ pid: false, cli: true })
      expect(await focusWith(extensionView({ entrypoint }), fake.steps)).toBe<FocusOutcome>('failed')
      expect(fake.cliCalls).toEqual([])
      const unknownWindow = fakeSteps({ pid: false, cli: true })
      const view = extensionView({ entrypoint, windowPid: undefined, workspaceFolder: undefined })
      expect(await focusWith(view, unknownWindow.steps)).toBe<FocusOutcome>('failed')
      expect(unknownWindow.cliCalls).toEqual([])
    }
  })

  it('still tries the verified pid path for a session outside the extension', async () => {
    const fake = fakeSteps({ pid: true, cli: true })
    expect(await focusWith(extensionView({ entrypoint: 'cli' }), fake.steps)).toBe<FocusOutcome>('pid')
    expect(fake.pidCalls).toEqual([900])
  })

  it('keeps the CLI fallback when the entrypoint is unknown', async () => {
    const fake = fakeSteps({ pid: false, cli: true })
    expect(await focusWith(extensionView({ entrypoint: undefined }), fake.steps)).toBe<FocusOutcome>('workspace')
    expect(fake.cliCalls).toEqual(['p:\\proj\\alpha'])
  })
})

describe('codeCliCommand', () => {
  it('opens the folder without -r, so an existing window is never taken over', () => {
    // `-r` would open the folder in the most recently active window and replace its workspace.
    expect(codeCliCommand('C:\\work\\alpha')).toBe('code "C:\\work\\alpha"')
    expect(codeCliCommand('C:\\')).toBe('code "C:\\\\"')
  })

  it('runs with a bounded timeout and no console window', () => {
    expect(CLI_EXEC_OPTIONS.windowsHide).toBe(true)
    expect(CLI_EXEC_OPTIONS.timeout).toBeGreaterThan(0)
    expect(CLI_EXEC_OPTIONS.timeout).toBeLessThanOrEqual(10_000)
  })
})

/** A fake user32 for focusing: records the calls and reports the window in front after a given number of queries. */
function fakeFocusApi(options: { iconic: boolean; foregroundAfter?: number }): {
  api: FocusApi
  restored: Array<[number, number]>
  foregroundSet: number[]
} {
  const restored: Array<[number, number]> = []
  const foregroundSet: number[] = []
  let queries = 0
  return {
    api: {
      IsIconic: () => (options.iconic ? 1 : 0),
      ShowWindowAsync: (hWnd, nCmdShow) => {
        restored.push([hWnd, nCmdShow])
        return 1
      },
      SetForegroundWindow: (hWnd) => {
        foregroundSet.push(hWnd)
        return 1
      },
      GetForegroundWindow: () => {
        queries++
        // A BigInt, as koffi's `intptr` can arrive at run time too.
        return options.foregroundAfter !== undefined && queries > options.foregroundAfter ? BigInt(42) : 7
      },
    },
    restored,
    foregroundSet,
  }
}

describe('bringToFront', () => {
  const SW_RESTORE = 9

  it('leaves a maximized or normal window as it is, only bringing it forward', async () => {
    const fake = fakeFocusApi({ iconic: false, foregroundAfter: 0 })
    expect(await bringToFront(fake.api, 42, () => Promise.resolve())).toBe(true)
    expect(fake.restored).toEqual([])
    expect(fake.foregroundSet).toEqual([42])
  })

  it('restores a minimized window asynchronously', async () => {
    const fake = fakeFocusApi({ iconic: true, foregroundAfter: 0 })
    expect(await bringToFront(fake.api, 42, () => Promise.resolve())).toBe(true)
    expect(fake.restored).toEqual([[42, SW_RESTORE]])
  })

  it('polls the foreground window briefly, because the restore is asynchronous', async () => {
    const waits: number[] = []
    const fake = fakeFocusApi({ iconic: true, foregroundAfter: 2 })
    const wait = (ms: number): Promise<void> => {
      waits.push(ms)
      return Promise.resolve()
    }
    expect(await bringToFront(fake.api, 42, wait)).toBe(true)
    expect(waits).toEqual([FOREGROUND_POLL_INTERVAL_MS, FOREGROUND_POLL_INTERVAL_MS])
  })

  it('gives up after a bounded wait of about 100 ms, so the CLI fallback can run', async () => {
    const waits: number[] = []
    const fake = fakeFocusApi({ iconic: false })
    const wait = (ms: number): Promise<void> => {
      waits.push(ms)
      return Promise.resolve()
    }
    expect(await bringToFront(fake.api, 42, wait)).toBe(false)
    expect(waits).toHaveLength(FOREGROUND_POLL_ATTEMPTS)
    const total = waits.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBeGreaterThanOrEqual(80)
    expect(total).toBeLessThanOrEqual(150)
  })

  it('waits with real timers by default instead of spinning', async () => {
    const fake = fakeFocusApi({ iconic: false })
    const started = performance.now()
    expect(await bringToFront(fake.api, 42)).toBe(false)
    expect(performance.now() - started).toBeGreaterThanOrEqual(FOREGROUND_POLL_ATTEMPTS * FOREGROUND_POLL_INTERVAL_MS - 10)
  })
})

describe('tabFocusUri', () => {
  const expected = `vscode://anthropic.claude-code/open?session=${SESSION_ID}`

  it('builds the extension URI after the fast path or the workspace path focused the window', () => {
    expect(tabFocusUri(extensionView(), 'pid', true, [])).toBe(expected)
    expect(tabFocusUri(extensionView(), 'workspace', true, [])).toBe(expected)
  })

  it('sends nothing when the window focus failed', () => {
    // The URI goes to the topmost VSCode window: if that is not the session's, it would open a new tab.
    expect(tabFocusUri(extensionView(), 'failed', true, [])).toBeUndefined()
  })

  it('sends nothing after a cwd fallback, which may have opened a brand-new window', () => {
    expect(tabFocusUri(extensionView(), 'cwd', true, [])).toBeUndefined()
    expect(
      tabFocusUri(extensionView({ windowPid: undefined, workspaceFolder: undefined }), 'cwd', true, []),
    ).toBeUndefined()
  })

  it('sends nothing when the session window is unknown, whatever the outcome claims', () => {
    const view = extensionView({ windowPid: undefined, workspaceFolder: undefined })
    expect(tabFocusUri(view, 'pid', true, [])).toBeUndefined()
    expect(tabFocusUri(view, 'workspace', true, [])).toBeUndefined()
  })

  it('sends nothing for a session that does not run in the VS Code extension', () => {
    for (const entrypoint of ['cli', 'sdk-ts', '', 'Claude-VSCode', 'claude-vscode ', undefined]) {
      expect(tabFocusUri(extensionView({ entrypoint }), 'pid', true, [])).toBeUndefined()
    }
  })

  it('sends nothing for a session id that is not a UUID', () => {
    for (const sessionId of [
      '',
      'abc',
      `${SESSION_ID}&x=1`,
      `${SESSION_ID}\n`,
      ` ${SESSION_ID}`,
      '../../etc',
      '0b5c1d7e-3f2a-4c8b-9e6d-1a2b3c4d5e6', // one character short
      '0b5c1d7e3f2a4c8b9e6d1a2b3c4d5e6f', // without hyphens
      'zb5c1d7e-3f2a-4c8b-9e6d-1a2b3c4d5e6f',
    ]) {
      expect(tabFocusUri(extensionView({ sessionId }), 'pid', true, [])).toBeUndefined()
    }
  })

  it('sends nothing when the setting is off', () => {
    expect(tabFocusUri(extensionView(), 'pid', false, [])).toBeUndefined()
  })

  it('sends nothing while the session has a pending file edit, so the proposed diff stays in front', () => {
    // For a file write VSCode opens a split diff tab; the tab URI would switch away from it to the
    // chat tab. Also for a released request: the native prompt and the diff are open then too.
    expect(tabFocusUri(extensionView(), 'pid', true, [{ sessionId: SESSION_ID, kind: 'edit' }])).toBeUndefined()
    expect(
      tabFocusUri(extensionView(), 'workspace', true, [
        { sessionId: SESSION_ID, kind: 'tool' },
        { sessionId: SESSION_ID, kind: 'edit' },
      ]),
    ).toBeUndefined()
  })

  it('still sends the URI when the pending edit belongs to another session', () => {
    const other = '1b5c1d7e-3f2a-4c8b-9e6d-1a2b3c4d5e6f'
    expect(tabFocusUri(extensionView(), 'pid', true, [{ sessionId: other, kind: 'edit' }])).toBe(expected)
  })

  it('still sends the URI for the other decision kinds', () => {
    for (const kind of ['tool', 'question', 'plan'] as const) {
      expect(tabFocusUri(extensionView(), 'pid', true, [{ sessionId: SESSION_ID, kind }])).toBe(expected)
    }
  })

  it('waits a short, bounded time before sending, so VS Code registers the window as last-active', () => {
    expect(TAB_FOCUS_SETTLE_MS).toBeGreaterThanOrEqual(150)
    expect(TAB_FOCUS_SETTLE_MS).toBeLessThanOrEqual(300)
  })
})

describe('isSafeForCli', () => {
  it('accepts ordinary folders, including spaces, ampersands and parentheses', () => {
    expect(isSafeForCli('p:\\08_Apps\\ClaudeSwitcher')).toBe(true)
    expect(isSafeForCli('C:\\My Projects\\R&D (old)')).toBe(true)
  })

  it('rejects folders cmd.exe would reinterpret even inside quotes', () => {
    // As a review measured, `%TEMP%` silently expands to a DIFFERENT path.
    expect(isSafeForCli('C:\\work\\%TEMP%')).toBe(false)
    expect(isSafeForCli('C:\\work\\a"b')).toBe(false)
  })

  it('accepts absolute drive paths with either slash, drive roots and UNC shares', () => {
    expect(isSafeForCli('C:/work/project')).toBe(true)
    expect(isSafeForCli('C:\\')).toBe(true)
    expect(isSafeForCli('\\\\server\\share')).toBe(true)
    expect(isSafeForCli('\\\\server\\share\\project')).toBe(true)
  })

  it('rejects a folder the code CLI would read as an option', () => {
    // The case a security review found: after quoting, `code` would still receive this as an option.
    expect(isSafeForCli('--install-extension=C:\\x\\evil.vsix')).toBe(false)
    expect(isSafeForCli('-n')).toBe(false)
  })

  it('rejects relative, drive-relative and rooted-but-driveless paths', () => {
    expect(isSafeForCli('project')).toBe(false)
    expect(isSafeForCli('.\\project')).toBe(false)
    expect(isSafeForCli('C:project')).toBe(false)
    expect(isSafeForCli('\\work\\project')).toBe(false)
    expect(isSafeForCli('')).toBe(false)
  })

  it('rejects incomplete UNC paths and Win32 device namespaces', () => {
    expect(isSafeForCli('\\\\server')).toBe(false)
    expect(isSafeForCli('\\\\server\\')).toBe(false)
    expect(isSafeForCli('\\\\?\\C:\\work')).toBe(false)
    expect(isSafeForCli('\\\\.\\pipe\\x')).toBe(false)
  })

  it('rejects control characters anywhere', () => {
    expect(isSafeForCli('C:\\work\nproject')).toBe(false)
    expect(isSafeForCli('C:\\work\u0000')).toBe(false)
    expect(isSafeForCli('C:\\work\u001b[31m')).toBe(false)
    expect(isSafeForCli('C:\\work\u007f')).toBe(false)
    expect(isSafeForCli('C:\\work\u0085')).toBe(false)
  })
})
