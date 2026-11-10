import { exec, type ExecOptions } from 'node:child_process'
import { createRequire } from 'node:module'
import type { PermissionRequestInfo, SessionView } from '@claudeswitcher/core'

// Not named `require`: in the module wrapper of the CJS bundle `require` already exists as a
// parameter, and a `const` of the same name would clash with it.
const requireNative = createRequire(import.meta.url)

const SW_RESTORE = 9
const GW_HWNDNEXT = 2

interface User32 {
  // In koffi an `intptr` return value can be a `number` or a `bigint` at run time.
  GetTopWindow(hWnd: number): number | bigint
  GetWindow(hWnd: number, uCmd: number): number | bigint
  GetWindowThreadProcessId(hWnd: number, pid: [number]): number
  IsWindowVisible(hWnd: number): number
  GetWindowTextLengthW(hWnd: number): number
  GetForegroundWindow(): number | bigint
  SetForegroundWindow(hWnd: number): number
  IsIconic(hWnd: number): number
  ShowWindowAsync(hWnd: number, nCmdShow: number): number
}

/** `undefined`: not tried yet. `null`: loading failed. */
let user32: User32 | null | undefined

/**
 * Loads the user32 bindings lazily and swallows an error.
 *
 * Deliberately not at module level: `index.ts` imports `focus-window.ts` before `app.whenReady()`,
 * so a module-level koffi error would throw BEFORE the startup error dialog is wired up, and the
 * app would die silently, without a dialog. This way an unavailable native module only disables the
 * fast focus path; the `code` CLI fallback keeps working.
 */
function loadUser32(): User32 | null {
  if (user32 !== undefined) return user32
  try {
    const koffi = requireNative('koffi') as typeof import('koffi')
    const lib = koffi.load('user32.dll')
    user32 = {
      GetTopWindow: lib.func('intptr GetTopWindow(intptr hWnd)'),
      GetWindow: lib.func('intptr GetWindow(intptr hWnd, uint32 uCmd)'),
      GetWindowThreadProcessId: lib.func(
        'uint32 GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *pid)',
      ),
      // A Win32 BOOL is a 4-byte int, not the 1-byte C bool.
      IsWindowVisible: lib.func('int IsWindowVisible(intptr hWnd)'),
      GetWindowTextLengthW: lib.func('int GetWindowTextLengthW(intptr hWnd)'),
      GetForegroundWindow: lib.func('intptr GetForegroundWindow()'),
      SetForegroundWindow: lib.func('int SetForegroundWindow(intptr hWnd)'),
      IsIconic: lib.func('int IsIconic(intptr hWnd)'),
      ShowWindowAsync: lib.func('int ShowWindowAsync(intptr hWnd, int nCmdShow)'),
    }
  } catch (error) {
    console.error('[focus] user32 bindings unavailable; falling back to the code CLI only', error)
    user32 = null
  }
  return user32
}

/**
 * Upper bound on the windows walked. A Windows desktop typically has a few hundred top-level
 * windows. The bound keeps an unexpected type (for example `koffi` returning `intptr` as a BigInt,
 * so that `hwnd !== 0` would never be false) from sending the Electron main process into an endless
 * loop, which would freeze the whole app.
 */
const MAX_WINDOWS_SCANNED = 10_000

/** The user32 subset the window walk needs, so it can be tested with a fake. */
export type WindowScanner = Pick<
  User32,
  'GetTopWindow' | 'GetWindow' | 'GetWindowThreadProcessId' | 'IsWindowVisible' | 'GetWindowTextLengthW'
>

/**
 * The visible, titled top-level windows of the given process, at most `cap` of them.
 *
 * It deliberately walks the GetTopWindow + GetWindow chain, not EnumWindows: EnumWindows takes a
 * callback that has to be registered in koffi, and the lifetime of a registered callback easily goes
 * wrong in the Electron main process. Walking the chain gives the same result with plain scalar
 * calls.
 *
 * Thanks to `cap` the whole desktop need not be walked: the callers only care whether there are
 * zero, one or more than one windows.
 */
export function scanWindowsForPid(api: WindowScanner, targetPid: number, cap = 2): number[] {
  const found: number[] = []
  const pidOut: [number] = [0]
  let hwnd = Number(api.GetTopWindow(0))

  for (let scanned = 0; hwnd !== 0 && scanned < MAX_WINDOWS_SCANNED; scanned++) {
    if (api.IsWindowVisible(hwnd) !== 0 && api.GetWindowTextLengthW(hwnd) > 0) {
      api.GetWindowThreadProcessId(hwnd, pidOut)
      if (pidOut[0] === targetPid) {
        found.push(hwnd)
        if (found.length >= cap) return found
      }
    }
    hwnd = Number(api.GetWindow(hwnd, GW_HWNDNEXT))
  }
  return found
}

/**
 * The window of the given process, BUT only if there is exactly one. Otherwise 0.
 *
 * Why is the first match not enough? Measured live, not assumed: a VSCode main process owns ALL
 * its windows, and in the `~/.claude/ide/*.lock` files a single pid belongs to 8 to 12 DIFFERENT
 * workspace folders (one pid to ten folders while it had a single window). So a pid does not
 * identify a window. The first match in Z order would be the TOPMOST window, not the session's, so
 * Enter would bring up another project's window, and since `SetForegroundWindow` succeeds, the
 * `code` CLI fallback, which would find the right one, would not run either.
 *
 * Without an unambiguous match it therefore picks none: the caller falls back to the `code` CLI,
 * which works from the folder and uses VSCode's own window resolution.
 */
export function findMainWindow(targetPid: number): number {
  const api = loadUser32()
  if (api === null) return 0
  const windows = scanWindowsForPid(api, targetPid)
  const only = windows[0]
  return windows.length === 1 && only !== undefined ? only : 0
}

/**
 * The number of visible windows the process has, stopping at two.
 *
 * Separate from `findMainWindow` because the live test uses it to prove that the out parameter of
 * `GetWindowThreadProcessId` really writes: for a process owning several windows `findMainWindow`
 * correctly returns 0, which looks the same as an out parameter that does not work.
 */
export function countMainWindows(targetPid: number): number {
  const api = loadUser32()
  if (api === null) return 0
  return scanWindowsForPid(api, targetPid).length
}

/**
 * True if the fast, pid-based focus path is available, that is the user32 bindings loaded. For the
 * startup log: because of the lazy loading `koffi` would otherwise load only on the first focus
 * request, and until then nothing would prove that it works in the Electron main process.
 */
export function isFastFocusAvailable(): boolean {
  return loadUser32() !== null
}

/** The window currently in the foreground, or 0. Only reads, brings nothing forward. */
export function foregroundWindow(): number {
  const api = loadUser32()
  return api === null ? 0 : Number(api.GetForegroundWindow())
}

/** The user32 subset focusing needs, so `bringToFront` can be tested with a fake. */
export type FocusApi = Pick<User32, 'IsIconic' | 'ShowWindowAsync' | 'SetForegroundWindow' | 'GetForegroundWindow'>

/** How many times the foreground window is checked again, `FOREGROUND_POLL_INTERVAL_MS` apart. */
export const FOREGROUND_POLL_ATTEMPTS = 5
export const FOREGROUND_POLL_INTERVAL_MS = 20

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Brings the window to the front and returns true if it really is the one in the foreground.
 *
 * - Only a minimised window is restored (`IsIconic`). `SW_RESTORE` would also return a maximised
 *   window to its normal size, so every jump would shrink the user's maximised VSCode.
 * - `ShowWindowAsync`, not `ShowWindow`: `ShowWindow` is synchronous on another process's window,
 *   and with a frozen VSCode it would block the main thread, and with it the daemon and every
 *   session hook.
 * - The return value of `SetForegroundWindow` is not reliable: under the Windows foreground lock it
 *   can report "success" while it only flashes the taskbar button. Believing it would mean the
 *   `code` CLI fallback never runs. So it checks what actually came to the foreground. Since the
 *   restore is asynchronous, it checks several times for a short while (at most about 100 ms), with
 *   a timer, not a busy loop.
 */
export async function bringToFront(
  api: FocusApi,
  hwnd: number,
  wait: (ms: number) => Promise<void> = delay,
): Promise<boolean> {
  if (api.IsIconic(hwnd) !== 0) api.ShowWindowAsync(hwnd, SW_RESTORE)
  api.SetForegroundWindow(hwnd)

  let waited = 0
  while (Number(api.GetForegroundWindow()) !== hwnd) {
    if (waited === FOREGROUND_POLL_ATTEMPTS) return false
    await wait(FOREGROUND_POLL_INTERVAL_MS)
    waited++
  }
  return true
}

async function focusByPid(pid: number): Promise<boolean> {
  const api = loadUser32()
  if (api === null) return false
  const hwnd = findMainWindow(pid)
  if (hwnd === 0) return false
  return bringToFront(api, hwnd)
}

/**
 * Characters cmd.exe interprets even inside quotes: `%` expands as an environment variable, and a
 * `"` would break the quoting itself. `&`, `^`, `|`, `<`, `>`, `(`, `)` are harmless inside quotes,
 * as a review measured empirically.
 */
const CMD_UNSAFE_IN_QUOTES = /[%"]/

/**
 * The start of an absolute Windows path: a drive (`X:\` or `X:/`) or a UNC share
 * (`\\server\share`). The `\\?\` and `\\.\` device namespaces are not shares; the `?` and `.`
 * excluded from the server name filter them out.
 */
const ABSOLUTE_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/?.][^\\/]*\\[^\\/]+)/

/** True if the text contains a C0 or C1 control character, or DEL. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/**
 * True if the folder can safely be passed to the `code` CLI through a cmd.exe shell.
 *
 * The folder comes from the registry or from an `ide/*.lock` file, where only its type is checked.
 * A value starting with `-` would reach `code` as an option even after quoting (for example
 * `--install-extension=...`), so only an absolute path is allowed, which never starts with `-`. A
 * control character (a line break, for example) never occurs in a real folder name, but can mean
 * something else on the cmd.exe command line.
 */
export function isSafeForCli(folder: string): boolean {
  if (folder.startsWith('-')) return false
  if (!ABSOLUTE_WINDOWS_PATH.test(folder)) return false
  if (hasControlCharacter(folder)) return false
  return !CMD_UNSAFE_IN_QUOTES.test(folder)
}

/**
 * Quotes a folder so that the Windows CRT argv parser returns exactly that folder.
 *
 * The CRT treats the backslashes before a closing quote as escapes: N backslashes and a `"` give
 * N/2 backslashes, and with an odd N the `"` is taken literally too. With plain quoting a `C:\`
 * workspace would therefore arrive as `C:"`, a `\\server\share\` would lose its closing quote, and
 * a `double\\` would lose a backslash, so drive-root and share-root workspaces would silently get a
 * wrong path. Measured, not assumed: plain quoting broke the path in 4 cases out of 7.
 *
 * Doubling the trailing run of backslashes compensates for this. Elsewhere a backslash is literal,
 * and a `"` cannot occur in the folder because `isSafeForCli` excludes it.
 */
export function quoteForCli(folder: string): string {
  return `"${folder.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * The command that brings the folder up in VSCode.
 *
 * Deliberately without `-r`. `-r` opens the folder in the most recently active window: if the
 * folder is open nowhere, it replaces that window's workspace and reloads it, together with the
 * Claude Code sessions running in it. Without `-r` the window of an already open folder still comes
 * up, and a folder that is not open gets a new window and takes no existing window away.
 */
export function codeCliCommand(folder: string): string {
  return `code ${quoteForCli(folder)}`
}

/**
 * The run options of the `code` CLI. Without a timeout a stuck `code.cmd` (an update, a stalled
 * single-instance handshake) would never complete the `session:focus` request, and the overlay
 * would stay up.
 */
export const CLI_EXEC_OPTIONS = { windowsHide: true, timeout: 10_000 } as const satisfies ExecOptions

function focusByCli(folder: string): Promise<boolean> {
  // With such a folder name it does not even try: expanding `%` would silently open a DIFFERENT
  // path. A missed focus is better than a wrong one.
  if (!isSafeForCli(folder)) return Promise.resolve(false)

  // On Windows `code` is `code.cmd`, hence the shell. The whole command is passed as a single
  // string, and `quoteForCli` does the quoting, in one place and tested.
  return new Promise((resolve) => {
    exec(codeCliCommand(folder), CLI_EXEC_OPTIONS, (error) => {
      resolve(error === null)
    })
  })
}

/**
 * Which path brought the window up. The tab focus needs this, not a bare "it worked":
 * - `pid`: the fast path, and the window that came to the front was checked (`bringToFront`);
 * - `workspace`: the `code` CLI got the lock file's folder, and VSCode resolved the window itself;
 * - `cwd`: the `code` CLI got the session's cwd because the folder is unknown. If the cwd is open
 *   nowhere, this opened a BRAND NEW window, so it is unknown whether the session's window is in
 *   front;
 * - `failed`: neither path succeeded, or the CLI was skipped because the session is known not to
 *   run in the VSCode extension.
 */
export type FocusOutcome = 'pid' | 'workspace' | 'cwd' | 'failed'

/** The two focus steps, so the order in `focusWith` can be tested without bringing up a window. */
export interface FocusSteps {
  byPid(pid: number): Promise<boolean>
  byCli(folder: string): Promise<boolean>
}

/** The registry `entrypoint` value of a session running in the VSCode extension. */
const VSCODE_ENTRYPOINT = 'claude-vscode'

/**
 * The decision logic of `focusSessionWindow`, with injected steps.
 *
 * First by the pid known from the lock file, because that is fast and its result is checked. But
 * only if that pid has exactly one window (see `findMainWindow`: a VSCode main process can own
 * several windows, and then the pid does not identify a window). With several windows, and
 * whenever the fast path fails for any reason, the `code` CLI decides by the folder.
 *
 * The CLI is skipped if the session's `entrypoint` is known and is not the VSCode extension's: a
 * terminal or SDK session has no VSCode window, and `code <folder>` would only open a new window for
 * it. With an unknown `entrypoint` the CLI fallback stays.
 */
export async function focusWith(view: SessionView, steps: FocusSteps): Promise<FocusOutcome> {
  if (view.windowPid !== undefined && (await steps.byPid(view.windowPid))) return 'pid'
  if (view.entrypoint !== undefined && view.entrypoint !== VSCODE_ENTRYPOINT) return 'failed'
  if (view.workspaceFolder !== undefined) {
    return (await steps.byCli(view.workspaceFolder)) ? 'workspace' : 'failed'
  }
  return (await steps.byCli(view.cwd)) ? 'cwd' : 'failed'
}

/** Brings the session's VSCode window to the front and says by which path (see `FocusOutcome`). */
export function focusSessionWindow(view: SessionView): Promise<FocusOutcome> {
  return focusWith(view, { byPid: focusByPid, byCli: focusByCli })
}

/**
 * The wait between bringing up the window and sending the tab focus URI. The URI goes to the
 * topmost, most recently active VSCode window (measured live, 2026-10-21): during the wait VSCode
 * processes the focus change and records the session's window as the last active one. Without it
 * the URI could still reach the previous window, which would open a new tab. Short, because the
 * user is waiting for it.
 */
export const TAB_FOCUS_SETTLE_MS = 200

/** A canonical UUID (8-4-4-4-12 hex). Claude Code session ids have this form. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The Claude Code extension URI that brings the session's existing tab forward, or `undefined` if
 * it is not safe to send. A pure function: the caller only sends what it gets.
 *
 * The extension handles the URI in the topmost VSCode window, and if the session is not in it, it
 * opens a NEW tab for it. That must never happen, so it is sent only if ALL of these hold:
 * - the window came up and is known to be the session's: the `pid` path checked the window that
 *   came to the front, and on the `workspace` path VSCode resolved it itself from the lock file's
 *   folder. The `cwd` path is not enough: `code <cwd>` may have opened a new window, and there the
 *   URI would open a second copy of the running session. With `failed` the topmost window can be
 *   any window;
 * - the session's window is known (`windowPid` or `workspaceFolder`), regardless of the outcome
 *   too, so that a contradictory outcome cannot open a tab either;
 * - the session runs in the VSCode extension: for a CLI or terminal session the extension would
 *   open a new tab;
 * - the id is a UUID: unchecked text never goes into a URL opened with `openExternal`;
 * - the setting is on;
 * - the session has no pending file-write request (the `edit` kind, whether held or released). In
 *   that case VSCode shows the proposed change in a split diff tab and the native prompt is open
 *   too; the URI would switch away from the diff, which the user wants to look at, to the chat tab
 *   (live test, 2026-10-22). Then only the window comes up.
 */
export function tabFocusUri(
  view: SessionView,
  outcome: FocusOutcome,
  enabled: boolean,
  decisions: readonly Pick<PermissionRequestInfo, 'sessionId' | 'kind'>[],
): string | undefined {
  if (!enabled) return undefined
  if (decisions.some((d) => d.sessionId === view.sessionId && d.kind === 'edit')) return undefined
  if (outcome !== 'pid' && outcome !== 'workspace') return undefined
  if (view.windowPid === undefined && view.workspaceFolder === undefined) return undefined
  if (view.entrypoint !== VSCODE_ENTRYPOINT) return undefined
  if (!UUID.test(view.sessionId)) return undefined
  return `vscode://anthropic.claude-code/open?session=${encodeURIComponent(view.sessionId)}`
}
