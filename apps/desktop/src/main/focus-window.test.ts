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

/** Egy hamis asztal: a megadott ablakok Z-sorrendben, láncba kötve. */
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

/** Egy futó, látható főablakkal rendelkező VSCode processz pidje, vagy undefined. */
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
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  ).trim()
  const pid = Number.parseInt(out, 10)
  return Number.isNaN(pid) ? undefined : pid
}

describe('findMainWindow', () => {
  it.skipIf(!onWindows)('loads the koffi bindings and returns 0 for a pid owning no window', () => {
    // Bizonyítja, hogy a user32 kötések betöltődnek a deklarált szignatúrákkal, és
    // hogy a bejáró ciklus leáll. FIGYELEM: önmagában NEM bizonyítja, hogy a
    // GetWindowThreadProcessId kimeneti paramétere működik — ha a pid sosem íródna
    // ki, ez a teszt akkor is 0-t kapna és átmenne. Azt a harmadik teszt fedi.
    expect(findMainWindow(999_999_998)).toBe(0)
  })

  it.skipIf(!onWindows)('returns a plain number rather than a BigInt', () => {
    // Egy BigInt HWND-vel a `hwnd !== 0` sosem lenne hamis.
    expect(typeof findMainWindow(999_999_998)).toBe('number')
  })

  it.skipIf(!onWindows)('finds the main window of a running VSCode instance', (ctx) => {
    // Ez az a teszt, ami ténylegesen igazolja a kimeneti paramétert: nullánál
    // nagyobb értéket csak akkor kaphatunk, ha a GetWindowThreadProcessId kiírta a
    // pidet, és az egyezett. Ablakot NEM hoz előtérbe — csak megkeresi.
    //
    // A `countMainWindows`-t használja, nem a `findMainWindow`-t: utóbbi egy több ablakot
    // birtokló processznél helyesen 0-t ad, ami megkülönböztethetetlen lenne egy nem
    // működő out-paramétertől — vagyis a teszt pont azt nem bizonyítaná, amiért létezik.
    const pid = runningVSCodeWindowPid()
    if (pid === undefined) {
      // Látható kihagyás, nem csendes átmenet: a futtatás kimenetében látszania kell.
      ctx.skip()
      return
    }
    expect(countMainWindows(pid)).toBeGreaterThan(0)
  })
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
    // Ez a valódi eset: egy VSCode főprocessz az összes ablakát birtokolja, és egy
    // lock-pid több workspace mappához tartozik. Ilyenkor a pid nem azonosít ablakot.
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
    // A focusByPid ezzel ellenőrzi, hogy a fókuszváltás ténylegesen megtörtént-e.
    // Az isFastFocusAvailable nélkül ez a teszt akkor is átmenne, ha a kötések el sem
    // töltődtek — a foregroundWindow ilyenkor 0-t ad, ami szintén véges szám. A
    // teszt csak olvas; nullánál nagyobb értéket nem követel, mert zárolt képernyőn
    // vagy fókuszváltás közben a Windows jogosan adhat 0-t.
    expect(isFastFocusAvailable()).toBe(true)
    const hwnd = foregroundWindow()
    expect(typeof hwnd).toBe('number')
    expect(Number.isFinite(hwnd)).toBe(true)
  })
})

describe('quoteForCli', () => {
  /** Átküldi az idézett tokent a valódi cmd.exe + CRT argv láncon, és visszaolvassa. */
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
    // Nem a string alakját állítja, hanem hogy a valódi feldolgozó ugyanazt adja
    // vissza. A javítás előtti sima idézés ezek közül négyet elrontott.
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
  })
})

const SESSION_ID = '0b5c1d7e-3f2a-4c8b-9e6d-1a2b3c4d5e6f'

/** Egy VSCode bővítményben futó session, ismert ablakkal — a tab-fókusz boldog esete. */
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

/** Hamis fókuszlépések: rögzítik, mit kértek tőlük, és semmit nem hoznak előre. */
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
    // Ez a rés a `windowPid !== undefined || workspaceFolder !== undefined` feltétel mögött: a
    // pid ismert, de a gyors út elbukott, így a `code` a cwd-t kapta, ami egy új ablakot
    // nyithatott. A kimenet ezt `cwd`-ként mondja meg, nem „sikerként".
    const fake = fakeSteps({ pid: false, cli: true })
    const view = extensionView({ workspaceFolder: undefined })
    expect(await focusWith(view, fake.steps)).toBe<FocusOutcome>('cwd')
  })

  it('reports failure when neither path brought a window forward', async () => {
    const fake = fakeSteps({ pid: false, cli: false })
    expect(await focusWith(extensionView(), fake.steps)).toBe<FocusOutcome>('failed')
  })

  it('never runs the CLI for a session that is known not to run in the VS Code extension', async () => {
    // Egy terminálos vagy SDK-s sessionnek nincs VS Code ablaka: a `code <mappa>` csak egy új
    // ablakot nyitna neki.
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
    // A `-r` a legutóbb aktív ablakba nyitná a mappát, és lecserélné annak munkaterületét.
    expect(codeCliCommand('C:\\work\\alpha')).toBe('code "C:\\work\\alpha"')
    expect(codeCliCommand('C:\\')).toBe('code "C:\\\\"')
  })

  it('runs with a bounded timeout and no console window', () => {
    expect(CLI_EXEC_OPTIONS.windowsHide).toBe(true)
    expect(CLI_EXEC_OPTIONS.timeout).toBeGreaterThan(0)
    expect(CLI_EXEC_OPTIONS.timeout).toBeLessThanOrEqual(10_000)
  })
})

/** Egy hamis user32 a fókuszhoz: rögzíti a hívásokat, és megadott lekérdezés után adja az előteret. */
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
        // BigInt, ahogy a koffi `intptr`-je futásidőben is jöhet.
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
    // A URI a legfelső VSCode ablakhoz megy: ha nem a session ablaka jött elő, az egy új tabot nyitna.
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
      '0b5c1d7e-3f2a-4c8b-9e6d-1a2b3c4d5e6', // egy karakterrel rövidebb
      '0b5c1d7e3f2a4c8b9e6d1a2b3c4d5e6f', // kötőjelek nélkül
      'zb5c1d7e-3f2a-4c8b-9e6d-1a2b3c4d5e6f',
    ]) {
      expect(tabFocusUri(extensionView({ sessionId }), 'pid', true, [])).toBeUndefined()
    }
  })

  it('sends nothing when the setting is off', () => {
    expect(tabFocusUri(extensionView(), 'pid', false, [])).toBeUndefined()
  })

  it('sends nothing while the session has a pending file edit, so the proposed diff stays in front', () => {
    // A VSCode a fájlírásnál egy osztott diff tabot nyit; a tab URI a chat tabra váltana el róla.
    // Visszaengedett (`released`) kérésnél is: a natív kérdés és a diff akkor is nyitva van.
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
    // A `%TEMP%` a review mérése szerint csendben egy MÁSIK útvonalra bontódik ki.
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
    // A security review esete: idézés után a `code` ezt kapcsolóként kapná meg.
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
