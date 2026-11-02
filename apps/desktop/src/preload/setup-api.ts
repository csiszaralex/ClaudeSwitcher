/**
 * The API the setup window's preload (`preload/setup.ts`) exposes as `window.claudeswitcherSetup`.
 * It is its own preload and its own API, not a part of `ClaudeSwitcherApi`: the setup page gets no
 * daemon token, no pending requests and no overlay channel. In its own file for the same reason as
 * `api.ts`: the preload imports `electron`, whose types would pull Node into the renderer's check.
 * Whatever returns `unknown`, the renderer reads with a check.
 */
export interface SetupApi {
  /** The window's state; the renderer reads it with `readSetupState`. */
  load: () => Promise<unknown>
  /** Sends a `SaveRequest`; the main process answers with a `SaveResult`. */
  save: (request: unknown) => Promise<unknown>
  /** Installs the Claude Code integration; the answer is an `InstallReply`. */
  installIntegration: () => Promise<unknown>
  /** Removes the Claude Code integration; the same answer as `installIntegration`. */
  uninstallIntegration: () => Promise<unknown>
  /**
   * Starts (`true`) or stops a hotkey capture. While it runs, the main process suspends the app's
   * own hotkey and reads the keys itself; the Alt+Space family, which Windows would give to the system
   * menu, comes in through temporary global shortcuts (`CAPTURE_SHORTCUTS`).
   */
  setCapture: (active: boolean) => Promise<unknown>
  /**
   * Subscribes to `setup:captured`: `{ accelerator }` for a captured combination, `{ cancelled: true }`
   * when the capture ended without one (Escape, the window lost focus). The renderer reads it with
   * `readCaptured`. Returns the unsubscribe function.
   */
  onCaptured: (callback: (payload: unknown) => void) => () => void
  /**
   * Subscribes to `setup:changed` (a setting changed elsewhere, for example in the tray); the
   * returned function unsubscribes. The callback gets no `IpcRendererEvent`, which would reach
   * `ipcRenderer`.
   */
  onChanged: (callback: () => void) => () => void
}
