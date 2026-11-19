import { exec, execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { SessionView } from '@claudeswitcher/core'
import type { ProcessTree } from './process-probe.js'
import {
  CLASSIC_CONSOLE_CLASS,
  CLI_EXEC_OPTIONS,
  FOREGROUND_POLL_ATTEMPTS,
  FOREGROUND_POLL_INTERVAL_MS,
  GW_HWNDNEXT,
  GW_OWNER,
  MAX_ANCESTORS,
  PSEUDO_CONSOLE_CLASS,
  SHELL_WINDOW_CLASSES,
  TAB_FOCUS_SETTLE_MS,
  ancestorChain,
  bringToFront,
  canGiveBack,
  captureForeground,
  codeCliCommand,
  countMainWindows,
  findMainWindow,
  findTerminalWindow,
  focusWith,
  foregroundTitleOf,
  foregroundWindow,
  isFastFocusAvailable,
  isSafeForCli,
  liveTerminalScanner,
  previousWindowOf,
  quoteForCli,
  readForegroundTitle,
  scanWindowsForPid,
  tabFocusUri,
  terminalWindowOf,
  type FocusApi,
  type FocusOutcome,
  type ForegroundReader,
  type ForegroundTitleReader,
  type GiveBackCheck,
  type TerminalWindowScanner,
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
      // Without the final `exit 0` the command exits with 1 when no Code process runs (the
      // suppressed error still counts), and `execFileSync` would throw instead of skipping.
      'Get-Process Code -ErrorAction SilentlyContinue | ' +
        'Where-Object { $_.MainWindowHandle -ne 0 } | ' +
        'Select-Object -First 1 -ExpandProperty Id; exit 0',
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

/** A fake process tree: each process with its recorded parent and, optionally, its start time. */
function fakeTree(processes: Array<{ pid: number; parent: number; start?: string }>): ProcessTree {
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  return {
    parentOf: (pid) => byPid.get(pid)?.parent,
    startFileTime: (pid) => byPid.get(pid)?.start,
  }
}

/** A fake desktop for the terminal search: top-level windows in Z order, with class and owner. */
function fakeDesktop(
  windows: Array<{ hwnd: number; pid: number; cls: string; owner?: number; visible?: boolean }>,
): TerminalWindowScanner {
  const byHwnd = new Map(windows.map((w) => [w.hwnd, w]))
  const order = windows.map((w) => w.hwnd)
  return {
    GetTopWindow: () => order[0] ?? 0,
    GetWindow: (hWnd: number, uCmd: number) => {
      // The module's own constants, and any other command fails: a wrong value cannot pass silently.
      if (uCmd === GW_OWNER) return byHwnd.get(hWnd)?.owner ?? 0
      if (uCmd !== GW_HWNDNEXT) throw new Error(`unexpected GetWindow command ${String(uCmd)}`)
      const index = order.indexOf(hWnd)
      return index === -1 ? 0 : (order[index + 1] ?? 0)
    },
    GetWindowThreadProcessId: (hWnd: number, pid: [number]) => {
      pid[0] = byHwnd.get(hWnd)?.pid ?? 0
      return 0
    },
    IsWindowVisible: (hWnd: number) => (byHwnd.get(hWnd)?.visible === true ? 1 : 0),
    className: (hWnd: number) => byHwnd.get(hWnd)?.cls ?? '',
  }
}

const VSCODE_CLASS = 'Chrome_WidgetWin_1'
const TERMINAL_CLASS = 'CASCADIA_HOSTING_WINDOW_CLASS'
const SESSION_PID = 4100
const SHELL_PID = 4000

function terminalWindowFor(tree: ProcessTree, desktop: TerminalWindowScanner, pid = SESSION_PID): number {
  return findTerminalWindow(desktop, ancestorChain(tree, pid))
}

describe('ancestorChain', () => {
  it('walks from the process up its listed ancestors, nearest first', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 1000 },
      { pid: 1000, parent: 600 },
    ])
    // 600 is not listed: it has exited, so the walk stops before it.
    expect(ancestorChain(tree, SESSION_PID)).toEqual([SESSION_PID, SHELL_PID, 1000])
  })

  it('is empty for a process that is no longer listed', () => {
    expect(ancestorChain(fakeTree([{ pid: SHELL_PID, parent: 1000 }]), SESSION_PID)).toEqual([])
  })

  it('stops at a cycle of stale parent ids', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 3000 },
      { pid: 3000, parent: SESSION_PID },
    ])
    expect(ancestorChain(tree, SESSION_PID)).toEqual([SESSION_PID, SHELL_PID, 3000])
    const self = fakeTree([{ pid: 0, parent: 0 }])
    expect(ancestorChain(self, 0)).toEqual([0])
  })

  it('stops at a parent that started after its child: a later process on a reused pid', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID, start: '133000000000000200' },
      { pid: SHELL_PID, parent: 1000, start: '133000000000000300' },
      { pid: 1000, parent: 600, start: '133000000000000100' },
    ])
    expect(ancestorChain(tree, SESSION_PID)).toEqual([SESSION_PID])
  })

  it('keeps a parent whose start time is unknown', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID, start: '133000000000000200' },
      { pid: SHELL_PID, parent: 1000 },
    ])
    expect(ancestorChain(tree, SESSION_PID)).toEqual([SESSION_PID, SHELL_PID])
  })

  it('walks at most MAX_ANCESTORS processes', () => {
    const processes = Array.from({ length: MAX_ANCESTORS * 3 }, (_, i) => ({ pid: 10_000 + i, parent: 10_001 + i }))
    expect(ancestorChain(fakeTree(processes), 10_000)).toHaveLength(MAX_ANCESTORS)
  })
})

describe('findTerminalWindow', () => {
  it("finds the VS Code window whose integrated terminal runs the session, not the main process's other window", () => {
    // claude → pwsh → Code (pty host) → Code (main) → explorer. The main process owns both VS Code
    // windows; the shell's pseudo console is owned by the right one.
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 3000 },
      { pid: 3000, parent: 2000 },
      { pid: 2000, parent: 1000 },
      { pid: 1000, parent: 600 },
    ])
    const desktop = fakeDesktop([
      { hwnd: 50, pid: 2000, cls: VSCODE_CLASS, visible: true },
      { hwnd: 60, pid: 2000, cls: VSCODE_CLASS, visible: true },
      { hwnd: 70, pid: 4500, cls: PSEUDO_CONSOLE_CLASS, owner: 50 },
      { hwnd: 80, pid: SHELL_PID, cls: PSEUDO_CONSOLE_CLASS, owner: 60 },
    ])
    expect(terminalWindowFor(tree, desktop)).toBe(60)
  })

  it('finds the Windows Terminal window a session started inside it runs in', () => {
    // claude → pwsh → WindowsTerminal → svchost.
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 3500 },
      { pid: 3500, parent: 800 },
      { pid: 800, parent: 700 },
    ])
    const desktop = fakeDesktop([
      { hwnd: 90, pid: 3500, cls: TERMINAL_CLASS, visible: true },
      { hwnd: 91, pid: SHELL_PID, cls: PSEUDO_CONSOLE_CLASS, owner: 90 },
    ])
    expect(terminalWindowFor(tree, desktop)).toBe(90)
  })

  it('finds the Windows Terminal window after the default-terminal hand-off, where the chain ends in explorer', () => {
    // claude → cmd → explorer: Windows Terminal is not an ancestor, only the pseudo console's owner.
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 1000 },
      { pid: 1000, parent: 600 },
    ])
    const desktop = fakeDesktop([
      { hwnd: 95, pid: 1000, cls: 'Shell_TrayWnd', visible: true },
      { hwnd: 90, pid: 3600, cls: TERMINAL_CLASS, visible: true },
      { hwnd: 92, pid: 3600, cls: TERMINAL_CLASS, visible: true },
      { hwnd: 91, pid: SHELL_PID, cls: PSEUDO_CONSOLE_CLASS, owner: 92 },
    ])
    expect(terminalWindowFor(tree, desktop)).toBe(92)
  })

  it('takes a visible classic console window itself, and ignores a hidden one', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 1000 },
      { pid: 1000, parent: 600 },
    ])
    const visible = fakeDesktop([
      { hwnd: 30, pid: 1000, cls: CLASSIC_CONSOLE_CLASS },
      { hwnd: 40, pid: SHELL_PID, cls: CLASSIC_CONSOLE_CLASS, visible: true },
    ])
    expect(terminalWindowFor(tree, visible)).toBe(40)
    const hidden = fakeDesktop([{ hwnd: 40, pid: SHELL_PID, cls: CLASSIC_CONSOLE_CLASS }])
    expect(terminalWindowFor(tree, hidden)).toBe(0)
  })

  it('prefers the nearest ancestor, whatever the Z order', () => {
    // A session in a shell nested in another terminal's shell: the inner one shows the session.
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 3900 },
      { pid: 3900, parent: 1000 },
      { pid: 1000, parent: 600 },
    ])
    const desktop = fakeDesktop([
      { hwnd: 71, pid: 3900, cls: PSEUDO_CONSOLE_CLASS, owner: 90 },
      { hwnd: 72, pid: SHELL_PID, cls: PSEUDO_CONSOLE_CLASS, owner: 60 },
    ])
    expect(terminalWindowFor(tree, desktop)).toBe(60)
  })

  it("finds nothing for a nearer pseudo console without an owner, rather than a farther ancestor's window", () => {
    // The farther console shows another terminal: a missed focus is better than a wrong one. Both Z
    // orders, so the result does not depend on which console the walk meets first.
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 3500 },
      { pid: 3500, parent: 800 },
    ])
    const ownerless = { hwnd: 72, pid: SHELL_PID, cls: PSEUDO_CONSOLE_CLASS }
    const farther = { hwnd: 73, pid: 3500, cls: PSEUDO_CONSOLE_CLASS, owner: 90 }
    expect(terminalWindowFor(tree, fakeDesktop([ownerless, farther]))).toBe(0)
    expect(terminalWindowFor(tree, fakeDesktop([farther, ownerless]))).toBe(0)
  })

  it("still takes a farther ancestor's console past a nearer hidden classic console window", () => {
    // A hidden ConsoleWindowClass window belongs to a background program: it does not decide.
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 3500 },
      { pid: 3500, parent: 800 },
    ])
    const desktop = fakeDesktop([
      { hwnd: 72, pid: SHELL_PID, cls: CLASSIC_CONSOLE_CLASS },
      { hwnd: 73, pid: 3500, cls: PSEUDO_CONSOLE_CLASS, owner: 90 },
    ])
    expect(terminalWindowFor(tree, desktop)).toBe(90)
  })

  it('finds nothing when no process of the chain owns a console window', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: 1000 },
    ])
    const desktop = fakeDesktop([
      { hwnd: 50, pid: SHELL_PID, cls: VSCODE_CLASS, visible: true },
      { hwnd: 70, pid: 4500, cls: PSEUDO_CONSOLE_CLASS, owner: 50 },
    ])
    expect(terminalWindowFor(tree, desktop)).toBe(0)
  })

  it('ends after a parent cycle without looping', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID },
      { pid: SHELL_PID, parent: SESSION_PID },
    ])
    const desktop = fakeDesktop([{ hwnd: 91, pid: SHELL_PID, cls: PSEUDO_CONSOLE_CLASS, owner: 90 }])
    expect(terminalWindowFor(tree, desktop)).toBe(90)
  })

  it('finds nothing for a stale session pid, even when a console of that pid exists', () => {
    // The session process exited: the pid is not listed, so no window is taken for it.
    const tree = fakeTree([{ pid: SHELL_PID, parent: 1000 }])
    const desktop = fakeDesktop([{ hwnd: 91, pid: SESSION_PID, cls: PSEUDO_CONSOLE_CLASS, owner: 90 }])
    expect(terminalWindowFor(tree, desktop)).toBe(0)
  })

  it('ignores the console of a later process on a reused parent pid', () => {
    const tree = fakeTree([
      { pid: SESSION_PID, parent: SHELL_PID, start: '133000000000000200' },
      { pid: SHELL_PID, parent: 1000, start: '133000000000000300' },
    ])
    const desktop = fakeDesktop([{ hwnd: 91, pid: SHELL_PID, cls: PSEUDO_CONSOLE_CLASS, owner: 90 }])
    expect(terminalWindowFor(tree, desktop)).toBe(0)
  })
})

describe('terminalWindowOf (live)', () => {
  it.skipIf(!onWindows)('walks the real process tree and desktop and ends with a plain number', () => {
    // Proves that the bindings and the process tree load and that both walks stop. It does NOT prove
    // that a class name is read (the next test does): the value depends on where the test runs (a
    // terminal or not), so only its type is checked. It only reads, nothing comes to the front.
    expect(isFastFocusAvailable()).toBe(true)
    expect(Number.isInteger(terminalWindowOf(process.pid))).toBe(true)
    expect(terminalWindowOf(999_999_998)).toBe(0)
  })

  it.skipIf(!onWindows)('reads a non-empty class name through the real GetClassNameW binding', () => {
    // Every window has a class, so if no top-level window reads one, the binding or the decoding of
    // its buffer does not work, and the terminal search could never match a class. It only reads the
    // first windows in Z order, nothing comes to the front.
    const scanner = liveTerminalScanner()
    expect(scanner).toBeDefined()
    if (scanner === undefined) return
    const names: string[] = []
    let hwnd = Number(scanner.GetTopWindow(0))
    for (let scanned = 0; hwnd !== 0 && scanned < 50; scanned++) {
      names.push(scanner.className(hwnd))
      hwnd = Number(scanner.GetWindow(hwnd, GW_HWNDNEXT))
    }
    expect(names.some((name) => name.length > 0)).toBe(true)
    // The length the binding returns cuts the buffer: no name carries the zero padding behind it.
    expect(names.every((name) => !name.includes('\u0000'))).toBe(true)
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

describe('previousWindowOf', () => {
  /** A fake foreground window of the given class and process. */
  function reader(hwnd: number, className: string, pid = 4242): ForegroundReader {
    return {
      GetForegroundWindow: () => hwnd,
      GetWindowThreadProcessId: (_hWnd, out) => {
        out[0] = pid
        return 1
      },
      className: () => className,
    }
  }

  it('remembers the foreground window with its process', () => {
    expect(previousWindowOf(reader(0x1234, 'Chrome_WidgetWin_1'))).toEqual({ hwnd: 0x1234, pid: 4242 })
  })

  it('remembers nothing without a foreground window', () => {
    expect(previousWindowOf(reader(0, ''))).toBeUndefined()
  })

  it('remembers neither the desktop nor a taskbar', () => {
    for (const className of SHELL_WINDOW_CLASSES) expect(previousWindowOf(reader(0x1234, className))).toBeUndefined()
    expect([...SHELL_WINDOW_CLASSES]).toEqual(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])
  })

  it('reads a BigInt handle as a plain number', () => {
    const api = { ...reader(0, 'Notepad'), GetForegroundWindow: () => 0x99n }
    expect(previousWindowOf(api)).toEqual({ hwnd: 0x99, pid: 4242 })
  })
})

describe('canGiveBack', () => {
  const previous = { hwnd: 0x1234, pid: 4242 }
  function check(overrides: { exists?: boolean; visible?: boolean; minimised?: boolean; pid?: number } = {}): GiveBackCheck {
    return {
      IsWindow: () => (overrides.exists ?? true ? 1 : 0),
      IsWindowVisible: () => (overrides.visible ?? true ? 1 : 0),
      IsIconic: () => (overrides.minimised ?? false ? 1 : 0),
      GetWindowThreadProcessId: (_hWnd, out) => {
        out[0] = overrides.pid ?? previous.pid
        return 1
      },
    }
  }

  it('allows a window that still exists, is visible, not minimised and has the same process', () => {
    expect(canGiveBack(check(), previous)).toBe(true)
  })

  it('refuses a window that is gone, hidden or minimised', () => {
    expect(canGiveBack(check({ exists: false }), previous)).toBe(false)
    expect(canGiveBack(check({ visible: false }), previous)).toBe(false)
    expect(canGiveBack(check({ minimised: true }), previous)).toBe(false)
  })

  it('refuses a handle another process has now: the window was replaced', () => {
    expect(canGiveBack(check({ pid: 5151 }), previous)).toBe(false)
  })
})

describe('captureForeground (live)', () => {
  it.skipIf(!onWindows)('reads the foreground window without changing it, as plain numbers', () => {
    // Only reads. On a locked screen, or with the desktop or the taskbar in front, the result is
    // rightly `undefined`.
    expect(isFastFocusAvailable()).toBe(true)
    const before = foregroundWindow()
    const captured = captureForeground()
    if (captured !== undefined) {
      expect(typeof captured.hwnd).toBe('number')
      expect(typeof captured.pid).toBe('number')
    }
    expect(foregroundWindow()).toBe(before)
  })
})

describe('foregroundTitleOf', () => {
  /** A fake foreground window with the given title and process; `copied` overrides what GetWindowTextW returns. */
  function reader(hwnd: number | bigint, title: string, pid = 4242, copied?: number): ForegroundTitleReader & { maxChars: number[] } {
    const maxChars: number[] = []
    return {
      maxChars,
      GetForegroundWindow: () => hwnd,
      GetWindowThreadProcessId: (_hWnd, out) => {
        out[0] = pid
        return 1
      },
      GetWindowTextW: (_hWnd, buffer, max) => {
        maxChars.push(max)
        const text = title.slice(0, max - 1)
        buffer.write(text, 0, 'utf16le')
        return copied ?? text.length
      },
    }
  }

  it('reads the foreground window, its process and its title, accents and the cut mark included', () => {
    const title = 'alpha - Számlázás mana…'
    expect(foregroundTitleOf(reader(0x1234, title), Buffer.alloc(1024))).toEqual({ hwnd: 0x1234, pid: 4242, title })
  })

  it('passes the buffer size in characters, so a long title is cut, not overflowed', () => {
    const api = reader(0x1234, 'x'.repeat(40))
    expect(foregroundTitleOf(api, Buffer.alloc(20))?.title).toBe('x'.repeat(9))
    expect(api.maxChars).toEqual([10])
  })

  it('reads nothing without a foreground window or without a title', () => {
    expect(foregroundTitleOf(reader(0, 'alpha'), Buffer.alloc(64))).toBeUndefined()
    expect(foregroundTitleOf(reader(0x1234, ''), Buffer.alloc(64))).toBeUndefined()
    expect(foregroundTitleOf(reader(0x1234, 'alpha', 4242, 0), Buffer.alloc(64))).toBeUndefined()
  })

  it('reads a BigInt handle as a plain number', () => {
    expect(foregroundTitleOf(reader(0x99n, 'alpha'), Buffer.alloc(64))?.hwnd).toBe(0x99)
  })
})

describe('readForegroundTitle (live)', () => {
  it.skipIf(!onWindows)('reads the foreground title through the real GetWindowTextW binding, without changing it', () => {
    // Only reads. On a locked screen, or with an untitled window in front, the result is rightly
    // `undefined`.
    expect(isFastFocusAvailable()).toBe(true)
    const before = foregroundWindow()
    const read = readForegroundTitle()
    if (read !== undefined) {
      expect(read.hwnd).toBe(before)
      expect(typeof read.pid).toBe('number')
      expect(read.title.length).toBeGreaterThan(0)
      expect(read.title).not.toContain('\u0000')
    }
    expect(foregroundWindow()).toBe(before)
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

/** A terminal session (`cli`), with its own process id and, by cwd, a VS Code lock as well. */
function terminalView(over: Partial<SessionView> = {}): SessionView {
  return extensionView({ entrypoint: 'cli', pid: 4100, ...over })
}

/** Fake focus steps: they record what was asked of them and bring nothing forward. */
function fakeSteps(result: { pid: boolean; cli: boolean; terminal?: boolean; ancestors?: readonly number[] }): {
  steps: Parameters<typeof focusWith>[1]
  pidCalls: number[]
  cliCalls: string[]
  terminalCalls: number[]
  runsUnderCalls: Array<[number, number]>
} {
  const pidCalls: number[] = []
  const cliCalls: string[] = []
  const terminalCalls: number[] = []
  const runsUnderCalls: Array<[number, number]> = []
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
      byTerminal: (pid) => {
        terminalCalls.push(pid)
        return Promise.resolve(result.terminal ?? false)
      },
      runsUnder: (pid, ancestor) => {
        runsUnderCalls.push([pid, ancestor])
        return (result.ancestors ?? []).includes(ancestor)
      },
    },
    pidCalls,
    cliCalls,
    terminalCalls,
    runsUnderCalls,
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
      expect(await focusWith(terminalView({ entrypoint }), fake.steps)).toBe<FocusOutcome>('failed')
      expect(fake.cliCalls).toEqual([])
      const unknownWindow = fakeSteps({ pid: false, cli: true })
      const view = terminalView({ entrypoint, windowPid: undefined, workspaceFolder: undefined })
      expect(await focusWith(view, unknownWindow.steps)).toBe<FocusOutcome>('failed')
      expect(unknownWindow.cliCalls).toEqual([])
    }
  })

  it('brings a terminal session up by its own process and reports the terminal path', async () => {
    const fake = fakeSteps({ pid: true, cli: true, terminal: true })
    expect(await focusWith(terminalView(), fake.steps)).toBe<FocusOutcome>('terminal')
    expect(fake.terminalCalls).toEqual([4100])
  })

  it('never takes the lock pid for a terminal session, which only its cwd matched to a VS Code window', async () => {
    // A CLI in Windows Terminal whose cwd is inside an open workspace gets that window's lock; with
    // one VS Code window the fast path would bring up VS Code instead of the terminal.
    const found = fakeSteps({ pid: true, cli: true, terminal: true })
    await focusWith(terminalView(), found.steps)
    expect(found.pidCalls).toEqual([])
    const missed = fakeSteps({ pid: true, cli: true, terminal: false })
    expect(await focusWith(terminalView(), missed.steps)).toBe<FocusOutcome>('failed')
    expect(missed.pidCalls).toEqual([])
  })

  it('fails a terminal session without a process id, without trying anything else', async () => {
    const fake = fakeSteps({ pid: true, cli: true, terminal: true })
    expect(await focusWith(terminalView({ pid: undefined }), fake.steps)).toBe<FocusOutcome>('failed')
    expect([...fake.pidCalls, ...fake.terminalCalls]).toEqual([])
    expect(fake.cliCalls).toEqual([])
  })

  it('falls back to the VS Code way when the terminal search misses and the VS Code process is an ancestor', async () => {
    // A `claude -p` started by an extension session's tool: no pseudo console of its own, but it runs
    // under the VS Code whose lock it got.
    const view = terminalView({ entrypoint: 'sdk-cli' })
    const byPid = fakeSteps({ pid: true, cli: true, terminal: false, ancestors: [900] })
    expect(await focusWith(view, byPid.steps)).toBe<FocusOutcome>('pid')
    expect(byPid.runsUnderCalls).toEqual([[4100, 900]])
    expect(byPid.cliCalls).toEqual([])
    const byCli = fakeSteps({ pid: false, cli: true, terminal: false, ancestors: [900] })
    expect(await focusWith(view, byCli.steps)).toBe<FocusOutcome>('workspace')
    expect(byCli.pidCalls).toEqual([900])
    expect(byCli.cliCalls).toEqual(['p:\\proj\\alpha'])
    const neither = fakeSteps({ pid: false, cli: false, terminal: false, ancestors: [900] })
    expect(await focusWith(view, neither.steps)).toBe<FocusOutcome>('failed')
  })

  it('takes no VS Code way when the VS Code process is not an ancestor, as for a CLI in Windows Terminal', async () => {
    const fake = fakeSteps({ pid: true, cli: true, terminal: false, ancestors: [3500] })
    expect(await focusWith(terminalView(), fake.steps)).toBe<FocusOutcome>('failed')
    expect(fake.runsUnderCalls).toEqual([[4100, 900]])
    expect(fake.pidCalls).toEqual([])
    expect(fake.cliCalls).toEqual([])
  })

  it('checks no ancestry when the terminal search found the window, or no VS Code window is known', async () => {
    const found = fakeSteps({ pid: true, cli: true, terminal: true, ancestors: [900] })
    expect(await focusWith(terminalView(), found.steps)).toBe<FocusOutcome>('terminal')
    expect(found.runsUnderCalls).toEqual([])
    const unknown = fakeSteps({ pid: true, cli: true, terminal: false, ancestors: [900] })
    expect(await focusWith(terminalView({ windowPid: undefined }), unknown.steps)).toBe<FocusOutcome>('failed')
    expect(unknown.runsUnderCalls).toEqual([])
    expect(unknown.cliCalls).toEqual([])
  })

  it('never takes the terminal path for an extension session or an unknown entrypoint', async () => {
    for (const entrypoint of ['claude-vscode', undefined]) {
      const fake = fakeSteps({ pid: false, cli: true, terminal: true })
      await focusWith(extensionView({ entrypoint, pid: 4100 }), fake.steps)
      expect(fake.terminalCalls).toEqual([])
    }
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

  it('never sends the URI after the terminal path', () => {
    // The window that came up is a terminal's: the extension has no tab of the session there. Even
    // with a contradictory view that claims the extension, the outcome alone refuses it.
    expect(tabFocusUri(terminalView(), 'terminal', true, [])).toBeUndefined()
    expect(tabFocusUri(extensionView({ pid: 4100 }), 'terminal', true, [])).toBeUndefined()
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
