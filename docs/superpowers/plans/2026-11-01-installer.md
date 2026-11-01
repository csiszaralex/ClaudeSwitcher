# Installer, autostart and first-run setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ClaudeSwitcher installs per user with an NSIS installer, starts at login, asks every unset setting in a first-run window, and never runs twice.

**Architecture:**
- One settings list in `src/shared/settings.ts` (no Node imports) feeds `config.ts`, a main-process settings service, the tray and a second renderer page (`setup.html`) with its own preload.
- Instance coordination uses the single-instance lock plus a small `instance.json` in `userData`. A second build shows the hand-over dialog itself and asks the running one to quit through the same `--quit` launch mode that the installer uses.
- electron-builder packages the existing electron-vite output. A custom NSIS include adds the shortcut page and replaces the default force-kill with a clean quit.

**Tech Stack:** Electron 45, electron-vite 6, React 19, electron-builder (newest stable, NSIS target), vitest 5, pnpm 12, Nx 24.

**Spec:** `docs/superpowers/specs/2026-10-31-installer-design.md`

## Global Constraints

- Branch `feat/installer` from `main` (`0ffd21a` or later). One commit per task. Agents stop at `git add` with an exact file list and never commit. No AI attribution anywhere.
- `pnpm verify` exits 0 after every task: foreground, timeout 600000. Test counts only grow (today: core 187, daemon 168, desktop 387 + 1 skipped).
- Non-test code: no `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `as any`, `as unknown as`, non-null `!`. No `execSync`/`execFileSync`/`spawnSync`.
- Renderer value imports only from `@claudeswitcher/core/browser` or local renderer and `src/shared` files. `src/shared` must not import `node:` modules.
- New code comments and docs in English. GUI strings in Hungarian, with no dash (– or —) inside a sentence.
- Agents never launch Electron (`dev`, `start`, the packaged exe, the installer), never write `~/.claude` or the app's `userData`, never kill processes. Building the installer (`dist`) is allowed: it does not launch the app.
- Network only for `pnpm add` and for electron-builder fetching its own tool binaries (NSIS) during `dist`.
- **Before any `pnpm add`, Alex must have quit the running ClaudeSwitcher:** it locks `node_modules`. The lead asks him; the agent does not install until told.
- `userData` stays `%APPDATA%\@claudeswitcher\desktop`. Port stays 47821 (`DAEMON_PORT`).
- Verify every factual claim you write into a comment or document against the code, including the claims in this plan.

## Review Focus

1. **An upgrade runs the old version's uninstaller silently.** electron-builder does that, with `--updated`. If our uninstall step runs there, every upgrade removes the Claude Code integration and autostart. Expected: both survive an upgrade. (Task 6.)
2. **A build from before this plan is running.** It writes no `instance.json` and ignores `additionalData`. A new build or `--quit` must not hang: the new build quits silently as today, and `--quit` exits non-zero within `HANDOVER_TIMEOUT_MS`, so the installer can say "close it from the tray". (Task 5.)
3. **A captured hotkey is taken or invalid.** Expected: the old hotkey keeps working, nothing is persisted, and the window shows why. (Task 3, `switchHotkey`.)
4. **The tray changes a setting while the setup window is open with unsaved edits.** Expected: untouched fields follow the tray, and fields the user edited keep the user's value. (Task 4, `mergeExternal`.)
5. **A hand-edited `config.json`** where `confirmed` is not an array, has unknown or duplicate keys, or the file is broken. Expected: it loads, unknown keys are ignored, and a broken file is never overwritten (today's rule). (Task 2.)

---

### Task 1: A packaged build that keeps `userData` and finds its icons

**Files:**
- Create: `apps/desktop/src/main/user-data.ts`, `apps/desktop/src/main/user-data.test.ts`
- Create: `apps/desktop/src/main/resources.ts`, `apps/desktop/src/main/resources.test.ts`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/scripts/make-icon.mjs`, `apps/desktop/resources/icon.png` (generated, committed)
- Modify: `apps/desktop/src/main/index.ts` (the `setPath` call, before `requestSingleInstanceLock`), `apps/desktop/src/main/tray.ts` (`resources` constant), `apps/desktop/package.json` (`dist` script, `electron-builder` devDependency through `pnpm add -D`), `pnpm-workspace.yaml` (only if `allowBuilds` needs a new key, with a reason comment), `knip.jsonc` (only if it flags the script).

**Interfaces:**
- Produces: `userDataDir(appData: string): string`, which returns `path.join(appData, '@claudeswitcher', 'desktop')`.
- Produces: `resourcesDir(packaged: boolean, resourcesPath: string, moduleDir: string): string`. Packaged, it returns `path.join(resourcesPath, 'icons')`; otherwise `path.join(moduleDir, '../../resources')`.

- [ ] **Step 1: Write failing tests**
  - `user-data.test.ts` › `keeps the directory today's builds use`: `userDataDir('C:\\Users\\u\\AppData\\Roaming')` equals `path.join('C:\\Users\\u\\AppData\\Roaming', '@claudeswitcher', 'desktop')`.
  - `resources.test.ts` › `packaged icons live next to app.asar`: `resourcesDir(true, 'C:\\app\\resources', 'C:\\app\\resources\\app.asar\\out\\main')` equals `path.join('C:\\app\\resources', 'icons')`.
  - `resources.test.ts` › `repo builds read the source folder`: `resourcesDir(false, 'ignored', 'p:\\proj\\alpha\\apps\\desktop\\out\\main')` equals `path.join('p:\\proj\\alpha\\apps\\desktop', 'resources')`.
- [ ] **Step 2: Run** `pnpm --filter @claudeswitcher/desktop exec vitest run src/main/user-data.test.ts src/main/resources.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement both functions.** In `index.ts`, call `app.setPath('userData', userDataDir(app.getPath('appData')))` as the first statement after the imports. It must run before `requestSingleInstanceLock`, because the lock is tied to `userData`. The comment says why: packaging sets `productName`, which would otherwise move the directory and lose the token. In `tray.ts`, the icon directory comes from `resourcesDir(app.isPackaged, process.resourcesPath, dirname)`. This closes the backlog item "`tray.ts`: az ikonok útja".
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: The icon.** `scripts/make-icon.mjs` reads `resources/tray.png` and writes `resources/icon.png` at 256×256, scaled up nearest-neighbour. Use only `node:zlib` and `node:fs`, with no new dependency. The script decodes and encodes 8-bit RGBA, non-interlaced PNGs, which is what `file resources/tray.png` reports. Run it once and commit its output.
- [ ] **Step 6: Package.** Run `pnpm --filter @claudeswitcher/desktop add -D electron-builder@<newest stable>`, after checking the version with `pnpm view electron-builder version`. Then write `electron-builder.yml`:
  - `appId: com.claudeswitcher.desktop`, `productName: ClaudeSwitcher`.
  - `directories: { output: release, buildResources: resources }`. `build/` is gitignored, so it is not used for resources.
  - `files: [out/**, package.json]`.
  - `extraResources: [{ from: resources, to: icons, filter: [tray*.png] }]`.
  - `electronDist: node_modules/electron/dist`, so packaging reuses the installed binary instead of downloading it.
  - `win: { target: nsis, icon: resources/icon.png }`.
  - `nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false, deleteAppDataOnUninstall: false }`.

  Add the script `"dist": "electron-vite build && electron-builder --win nsis"`.
- [ ] **Step 7: Verify the package without running it.**
  - `pnpm --filter @claudeswitcher/desktop dist` exits 0, and `release/ClaudeSwitcher Setup 0.0.0.exe` (or electron-builder's actual name, which you report) exists.
  - Run `pnpm --filter @claudeswitcher/desktop exec asar list release/win-unpacked/resources/app.asar`. If `asar` is not available, use electron-builder's `@electron/asar`. The list must contain `/out/main/index.js`, `/out/preload/index.cjs` and `/out/renderer/index.html`.
  - `release/win-unpacked/resources/icons/tray.png` and `tray-waiting.png` exist.
  - koffi's `.node` file is under `app.asar.unpacked`.

  Report each listing. If pnpm's layout breaks module collection, the fix belongs in `electron-builder.yml`, and the report says what was measured.
- [ ] **Step 8:** Run `pnpm verify`, then stage exactly the files above. Proposed message: `feat(desktop): build a Windows installer`.

### Task 2: One settings list and confirmed keys in `config.json`

**Files:**
- Create: `apps/desktop/src/shared/settings.ts`, `apps/desktop/src/shared/settings.test.ts`
- Modify: `apps/desktop/src/main/config.ts`, `apps/desktop/src/main/config.test.ts`, `apps/desktop/src/main/hotkey.ts` (the `DEFAULT_HOTKEY` import), `apps/desktop/tsconfig.node.json` and `apps/desktop/tsconfig.web.json` (`include` adds `src/shared/**/*`)

**Interfaces:**
- Produces, in `src/shared/settings.ts`:
  ```ts
  export type SettingKey = 'autostart' | 'hideAfterLastDecision' | 'jumpToTab' | 'hotkey'
  export interface SettingValues { autostart: boolean; hideAfterLastDecision: boolean; jumpToTab: boolean; hotkey: string }
  export type BooleanSettingKey = Exclude<SettingKey, 'hotkey'>
  export interface SettingDefinition { key: SettingKey; kind: 'boolean' | 'hotkey'; label: string }
  export const SETTINGS: readonly SettingDefinition[]          // window order: autostart, hideAfterLastDecision, jumpToTab, hotkey
  export const DEFAULT_HOTKEY = 'Shift+Alt+Space'               // moved here from config.ts with its comment
  export const DEFAULT_SETTINGS: SettingValues                  // { autostart: true, hideAfterLastDecision: true, jumpToTab: true, hotkey: DEFAULT_HOTKEY }
  export function isSettingKey(value: unknown): value is SettingKey
  export function parseSettingValues(raw: unknown): SettingValues | undefined   // exact shape, non-blank hotkey
  export function settingsToAsk(confirmed: ReadonlySet<SettingKey>, options: { autostartAvailable: boolean }): SettingKey[]  // SETTINGS order
  ```
  The labels are the tray's current texts, so both read one place: `'Induljon el bejelentkezéskor'`, `'Elrejtés az utolsó döntés után'`, `'Ugrás a pontos Claude-tabra'`, `'Gyorsbillentyű'`.
- Produces, in `config.ts`:
  ```ts
  export type StoredValues = Omit<SettingValues, 'autostart'>
  export interface StoredConfig { values: StoredValues; confirmed: ReadonlySet<SettingKey> }
  export async function loadConfig(dir: string): Promise<StoredConfig>        // never throws
  export async function saveSettings(dir: string, patch: Partial<StoredValues>, confirm: readonly SettingKey[]): Promise<boolean>  // replaces updateConfig; never throws
  ```
  On disk: the existing keys plus `"confirmed": SettingKey[]`. `saveSettings` writes the union with the already stored keys, deduplicated, in `SETTINGS` order. `configPath` stays exported only if something still imports it: Task 3 removes its last user.

- [ ] **Step 1: Write failing tests**
  - `settings.test.ts`:
    - `asks everything on a first start`: `settingsToAsk(new Set(), { autostartAvailable: true })` equals `['autostart', 'hideAfterLastDecision', 'jumpToTab', 'hotkey']`.
    - `asks only the new setting after an update`: confirmed `{hideAfterLastDecision, jumpToTab, hotkey}` gives `['autostart']`.
    - `never asks autostart where it cannot be set`: `settingsToAsk(new Set(), { autostartAvailable: false })` does not contain `'autostart'`. With the other three confirmed, it is `[]`.
    - `parseSettingValues`: rejects a missing key, a non-boolean flag, a blank hotkey and extra non-setting input types; accepts `DEFAULT_SETTINGS`.
  - `config.test.ts`:
    - `an existing config without confirmed keys loads as unconfirmed`: a file `{"hotkey":"Shift+Alt+K","hideAfterLastDecision":false,"jumpToTab":true}` gives values `{hotkey:'Shift+Alt+K', hideAfterLastDecision:false, jumpToTab:true}` and `confirmed.size === 0`.
    - `ignores unknown and malformed confirmed entries`: `"confirmed": ["jumpToTab","bogus",3,"jumpToTab"]` gives `{jumpToTab}`; `"confirmed": "jumpToTab"` gives an empty set.
    - `saveSettings merges confirmed keys and keeps foreign keys`: start from `{"own":1,"confirmed":["hotkey"]}`, call `saveSettings(dir, { jumpToTab: false }, ['jumpToTab'])`, and the file has `own: 1`, `jumpToTab: false`, `confirmed: ['jumpToTab','hotkey']` in `SETTINGS` order.
    - `saveSettings never writes into a broken file`: the file content is unchanged and the result is `false`.
    - The existing `loadConfig` and `updateConfig` tests are renamed or rewritten for the new signatures with the same guarantees.
- [ ] **Step 2: Run** `pnpm --filter @claudeswitcher/desktop exec vitest run src/shared src/main/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `config.ts` keeps its reading and writing guarantees (`transformSettingsFile`, per-key fallback, no write into a broken file). `DEFAULT_CONFIG` is derived from `DEFAULT_SETTINGS`, not restated.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5:** Run `pnpm verify` and stage the files. Message: `feat(desktop): record which settings the user confirmed`.

### Task 3: Settings service, autostart, tray and live hotkey switch

**Files:**
- Create: `apps/desktop/src/main/autostart.ts` + test, `apps/desktop/src/main/settings-service.ts` + test
- Modify: `apps/desktop/src/main/hotkey.ts` + test (`switchHotkey`), `apps/desktop/src/main/tray.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/shutdown.ts` (export `STOP_TIMEOUT_MS`, used by Task 5)

**Interfaces:**
- Consumes: `SETTINGS`, `SettingKey`, `SettingValues`, `BooleanSettingKey` (Task 2), and `StoredConfig` and `saveSettings` (Task 2).
- Produces:
  ```ts
  // autostart.ts
  export interface LoginItems { get(): { openAtLogin: boolean }; set(openAtLogin: boolean): void }
  export interface Autostart { readonly available: boolean; enabled(): boolean; set(enabled: boolean): void }
  export function createAutostart(packaged: boolean, items: LoginItems): Autostart
  // settings-service.ts
  export interface SettingsSnapshot { values: SettingValues; confirmed: ReadonlySet<SettingKey>; autostartAvailable: boolean }
  export interface SettingsService {
    snapshot(): SettingsSnapshot
    apply(patch: Partial<SettingValues>, confirm: readonly SettingKey[]): Promise<SettingsSnapshot>
    onChange(listener: (snapshot: SettingsSnapshot) => void): () => void
  }
  export function createSettingsService(deps: { stored: StoredConfig; autostart: Autostart; persist: (patch: Partial<StoredValues>, confirm: readonly SettingKey[]) => Promise<boolean> }): SettingsService
  // hotkey.ts
  export function switchHotkey(deps: { register: RegisterAccelerator; unregister: (accelerator: string) => void }, current: string, next: string, handler: () => void): { registration: HotkeyRegistration; switched: boolean }
  // tray.ts
  export interface TrayHandle { setWaiting(count: number): void; setNotice(text: string | undefined): void; setSettings(snapshot: SettingsSnapshot): void; setHotkey(registration: HotkeyRegistration): void; destroy(): void }
  createTray(options: { settings: SettingsSnapshot; hotkey: HotkeyRegistration; onToggle: (key: BooleanSettingKey, enabled: boolean) => void; onOpen; onSettings; onQuit; onInstall; onUninstall })
  ```

- [ ] **Step 1: Write failing tests**
  - `autostart.test.ts`:
    - `a repo build never registers`: with `packaged=false`, `set(true)` never calls `items.set`, `available` is false, and `enabled()` is false.
    - `a packaged build reads the OS state back`: `enabled()` returns `items.get().openAtLogin`, and `set(false)` calls `items.set(false)`.
  - `settings-service.test.ts`:
    - `apply changes values in memory even if persisting fails`: `persist` resolves `false`, and the snapshot still has the new value.
    - `autostart goes to the OS, not to persist`: `apply({autostart:false},['autostart'])` calls `autostart.set(false)`, `persist` receives no `autostart` key, and `confirm` still includes `'autostart'`.
    - `autostart is not confirmed where it is unavailable`: with `available=false`, `apply({}, ['autostart','jumpToTab'])` passes only `['jumpToTab']` to `persist`.
    - `listeners get every change`: two `apply` calls give two snapshots in order; an unsubscribed listener gets none.
    - `snapshot reads autostart from the OS`: `values.autostart === autostart.enabled()`.
  - `hotkey.test.ts` › `switchHotkey`:
    - `keeps the old hotkey when the new one is taken`: `register` returns `false` for `next`. The result has `switched: false`, the last `register` call is for `current`, and the returned registration names `current` with status `registered`.
    - `keeps the old hotkey when the new one is invalid`: `register` throws for `next`. The result is `switched: false`.
    - `switches when the new one registers`: `unregister(current)` is called before `register(next)`, and the result is `switched: true`.
    - `the same accelerator is a no-op`: no calls, `switched: true`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`switchHotkey`:** unregister `current`, try `next`. On anything but `registered`, re-register `current` and return `switched: false`.
  - **`tray.ts`:**
    - The checkbox labels come from `SETTINGS`.
    - An autostart checkbox is added. When `!autostartAvailable` it is disabled, with the label suffix `' (csak a telepített appban)'`.
    - A new item `'Beállítások…'` sits directly under the hotkey line and calls `onSettings`.
    - The `'Gyorsbillentyű átállítása… (újraindítás után él)'` item and `onEditHotkey` are removed.
    - `setSettings` and `setHotkey` rebuild the menu, using the same `destroyed` guard as `setNotice`.
  - **`index.ts`:**
    - It builds the service from `loadConfig` and `createAutostart(app.isPackaged, { get: () => app.getLoginItemSettings(), set: (openAtLogin) => { app.setLoginItemSettings({ openAtLogin }) } })`.
    - `persist` is `(patch, confirm) => saveSettings(userData, patch, confirm)`.
    - Tray toggles call `service.apply({ [key]: enabled }, [key])`.
    - One `onChange` listener updates the tray. When `hotkey` changed, it calls `switchHotkey`; if `!switched`, it reverts the in-memory value with `service.apply({ hotkey: previous }, [])`.
    - `settings:get` reads `service.snapshot().values.hideAfterLastDecision`, and `session:focus` reads `jumpToTab` the same way. The local `let` copies go.
    - `onSettings` is a stub that logs, until Task 4 wires the window.
    - `configPath` and the `shell.openPath` use are removed if they have no other user.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5:** Run `pnpm verify` and stage. Message: `feat(desktop): manage settings in one service with autostart`.

### Task 4: The setup window ("Első beállítás" / "Beállítások")

**Files:**
- Create in `apps/desktop/src/renderer/`: `setup.html`, `setup-main.tsx`, `SetupWindow.tsx`, `setup-view.ts` + test, `accelerator.ts` + test, `setup-window-api.ts`
- Create: `apps/desktop/src/preload/setup.ts`, `apps/desktop/src/preload/setup-api.ts`
- Create: `apps/desktop/src/main/harden-window.ts`, `apps/desktop/src/main/setup-window.ts`, `apps/desktop/src/main/setup-ipc.ts` + test
- Modify:
  - `apps/desktop/src/main/index.ts`: overlay hardening moves to `hardenWindow`; the setup IPC; auto-open; `onSettings`; the integration install as one shared function for the tray and the window.
  - `apps/desktop/src/main/ipc-sender.ts` + test, if a page parameter is needed.
  - `apps/desktop/electron.vite.config.ts`: renderer input `{ index, setup }` (both real paths under `RENDERER_ROOT`); preload input `{ index: src/preload/index.ts, setup: src/preload/setup.ts }`, still CJS.
  - `apps/desktop/tsconfig.web.json` and `tsconfig.web.test.json`: include `src/preload/setup-api.ts`.
  - `knip.jsonc`: entry `src/renderer/setup.html` and `src/renderer/setup-window-api.ts`.
  - `apps/desktop/src/renderer/styles.css`: the setup page's styles, which reuse the overlay's tokens.

**Interfaces:**
- Consumes: `SettingsService`, `SettingsSnapshot` (Task 3); `SETTINGS`, `settingsToAsk`, `parseSettingValues`, `isSettingKey` (Task 2); `HookInstallState` and `readHookInstallState` (`setup.ts`); `HotkeyRegistration`.
- Produces:
  ```ts
  // preload/setup-api.ts — exposed as window.claudeswitcherSetup; the token is NOT exposed here
  export interface SetupApi {
    load(): Promise<unknown>                 // SetupState
    save(request: unknown): Promise<unknown> // SaveResult
    installIntegration(): Promise<unknown>   // { ok: boolean; message: string }
    onChanged(callback: () => void): () => void   // main pushes 'setup:changed'
  }
  // renderer/setup-view.ts (pure)
  export interface SetupState { values: SettingValues; ask: SettingKey[]; autostartAvailable: boolean; hotkey: HotkeyRegistration; integration: HookInstallState['kind'] }
  export function readSetupState(raw: unknown): SetupState | undefined
  export function visibleSettings(state: SetupState, showAll: boolean): SettingKey[]   // showAll or ask.length===0 → all SETTINGS keys, else ask
  export function mergeExternal(edited: SettingValues, dirty: ReadonlySet<SettingKey>, incoming: SettingValues): SettingValues
  // renderer/accelerator.ts (pure)
  export function acceleratorFromKey(event: { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): string | undefined
  // main/setup-ipc.ts (pure parts)
  export interface SaveRequest { values: SettingValues; shown: SettingKey[] }
  export function parseSaveRequest(raw: unknown): SaveRequest | undefined
  export type SaveResult = { ok: true } | { ok: false; reason: string }
  ```
- IPC channels: `setup:load`, `setup:save`, `setup:install`, and the push `setup:changed`. Each handler first checks the sender against the setup page's `RendererLocation`. The overlay's handlers refuse the setup page, and the setup handlers refuse the overlay page. In dev the check stays origin-only, as `isOverlaySender` documents.

- [ ] **Step 1: Write failing tests**
  - `accelerator.test.ts`:
    - `{code:'Space', shiftKey, altKey}` gives `'Shift+Alt+Space'`, so `DEFAULT_HOTKEY` round-trips.
    - `{code:'KeyK', ctrlKey, shiftKey}` gives `'Control+Shift+K'`; `Digit3` gives `'3'`; `F9` alone gives `'F9'`; `ArrowUp` with Alt gives `'Alt+Up'`.
    - A modifier key alone (`ShiftLeft`) or a letter with no modifier gives `undefined`.
    - The modifier order is Control, Shift, Alt, Super.
  - `setup-view.test.ts`:
    - `visibleSettings` shows only `ask` on a first-run open and all keys with `showAll`.
    - `mergeExternal` keeps dirty keys from `edited` and takes the rest from `incoming`.
    - `readSetupState` rejects a payload missing `values` or with an unknown `integration` kind.
  - `setup-ipc.test.ts` › `parseSaveRequest`: it rejects unknown keys in `shown`, invalid `values` and a non-array `shown`, and it accepts a valid request.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the pure modules,** then rerun. Expected: PASS.
- [ ] **Step 4: The window and its wiring.**
  - **`hardenWindow(window: BrowserWindow): void`** holds what `createOverlay` does today: deny navigation, window open and webview, deny every permission. Both windows call it.
  - **`openSetupWindow({ showAll }: { showAll: boolean })`** opens or focuses one window. It is framed, not always on top, and sized to its content. It has the `setup.cjs` preload with `contextIsolation`, `sandbox` and no `nodeIntegration`.
  - **`setup:save`:** apply the values of `shown` keys, then `service.apply(pick(values, shown), shown)`. If the hotkey did not switch (Task 3), reply `{ ok:false, reason }` with the Hungarian `hotkeyLabel` text, and leave the window open. Otherwise reply `{ ok:true }`, and the renderer closes the window. Closing with X confirms nothing.
  - **The service listener** sends `setup:changed` to an open setup window.
  - **At startup,** after the tray exists: if `settingsToAsk(snapshot.confirmed, { autostartAvailable })` is not empty, call `openSetupWindow({ showAll: false })`. `onSettings` opens it with `showAll: true`.
  - **The renderer copy (Hungarian):**
    - The heading is `'Első beállítás'` when opened by itself and `'Beállítások'` from the tray.
    - The link is `'Minden beállítás'`, the button is `'Mentés'`.
    - An unavailable autostart is a disabled checkbox with `'csak a telepített appban'`.
    - The hotkey field shows the current value and says `'Nyomd le az új kombinációt'` while capturing. Escape cancels the capture.
    - The integration row shows `'Telepítve'`, `'Elavult, telepítsd újra'` or `'Nincs telepítve'`, with a `'Telepítés'` button. A missing integration never adds a key to `ask`.
  - **The integration install:** the tray item and `setup:install` share one function in `index.ts`, which installs, shows the dialogs and resyncs the notice. The window reloads its state afterwards.
- [ ] **Step 5: Verify the build output, without launching anything.** `pnpm --filter @claudeswitcher/desktop build` produces `out/renderer/setup.html` with the CSP meta filled in (no `__CLAUDESWITCHER_CSP__` left) and `out/preload/setup.cjs`. `grep -c token out/preload/setup.cjs` gives 0.
- [ ] **Step 6:** Run `pnpm verify` and stage. Message: `feat(desktop): add the first-run setup window`.

### Task 5: One instance, the build hand-over, and the `--quit` / `--uninstall` launch modes

**Files:**
- Create: `apps/desktop/src/main/instance.ts` + test, `apps/desktop/src/main/instance-file.ts` + test, `apps/desktop/src/main/wait-for-exit.ts` + test
- Modify: `apps/desktop/src/main/index.ts` (startup moves into `startApp()`, the lock flow below), and `docs/superpowers/specs/2026-10-31-installer-design.md` (the correction below)

**Interfaces:**
- Consumes: `STOP_TIMEOUT_MS` (Task 3), `userDataDir` (Task 1), `uninstallIntegration` (`setup.ts`), `Autostart` (Task 3).
- Produces:
  ```ts
  // instance.ts (pure)
  export interface BuildIdentity { execPath: string; appPath: string; renderer: 'dev-server' | 'file'; version: string; packaged: boolean }
  export type LaunchMode = 'normal' | 'quit' | 'uninstall'          // from '--quit' / '--uninstall' in argv
  export function launchMode(argv: readonly string[]): LaunchMode
  export function sameBuild(a: BuildIdentity, b: BuildIdentity): boolean   // win32-normalized, case-insensitive paths, same renderer
  export function describeBuild(build: BuildIdentity): string       // 'telepített, 1.2.0' | 'repóból, dev' | 'repóból, start'
  export type InstanceMessage = { kind: 'show'; build: BuildIdentity } | { kind: 'quit' }
  export function parseInstanceMessage(raw: unknown): InstanceMessage | undefined
  export interface InstanceRecord { pid: number; build: BuildIdentity }
  export function parseInstanceRecord(raw: unknown): InstanceRecord | undefined
  export const HANDOVER_TIMEOUT_MS: number   // STOP_TIMEOUT_MS + 8000, with the reason in a comment
  // instance-file.ts
  export function writeInstanceRecord(dir: string, record: InstanceRecord): Promise<void>
  export function readInstanceRecord(dir: string): Promise<InstanceRecord | undefined>   // never throws
  export function removeInstanceRecord(dir: string, pid: number): Promise<void>          // only if the file still names this pid
  // wait-for-exit.ts
  export function waitForExit(pid: number, timeoutMs: number, isRunning?: (pid: number) => boolean): Promise<boolean>   // polls every 200 ms; default isRunning = process.kill(pid, 0), with EPERM counting as running
  ```

**The flow, decided here** (the spec left the mechanism to the plan):
- **The renderer field.** `dev` and `start` both run `electron .` in `apps/desktop`, so `execPath` + `appPath` are equal for them. Only the `renderer` field (`ELECTRON_RENDERER_URL` set or not) tells them apart. Correct the spec's "Different build" bullet accordingly: it currently claims the pair alone separates them.
- **Normal start, lock acquired:** run `startApp()` as today, then `writeInstanceRecord`. The `before-quit` sequence calls `removeInstanceRecord` after the daemon stopped.
- **Normal start, lock refused:**
  - Read the record. If it is missing, unreadable, or the same build, quit silently, as today. The primary then shows the overlay.
  - Otherwise, after `app.whenReady()`, this second instance shows a `dialog.showMessageBox`: `Már fut egy ClaudeSwitcher (${describeBuild(record.build)}). Bezárjam, és ez induljon?`, with the buttons `['Bezárás és indítás', 'Mégse']`, `cancelId` 1.
  - **Mégse:** quit.
  - **Bezárás és indítás:** spawn this same build in `--quit` mode asynchronously (`spawn`, not `spawnSync`). The arguments are `['--quit']` when packaged and `[app.getAppPath(), '--quit']` otherwise. Then `waitForExit(record.pid, HANDOVER_TIMEOUT_MS)`, then `requestSingleInstanceLock` again. If it is acquired, `startApp()`; otherwise an error box, `'A futó ClaudeSwitcher nem zárult be. Zárd be a tálcáról, és indítsd újra.'`, then quit.
- **`--quit`:**
  - Lock acquired: nothing runs, so `app.exit(0)`, before `whenReady`.
  - Lock refused: the message `{ kind: 'quit' }` reaches the primary. Read the record. If there is none, `app.exit(1)`. Otherwise `waitForExit`, then `app.exit(0)` or `app.exit(1)` on timeout.
- **`--uninstall`:** first do what `--quit` does. Then, holding the lock, after `whenReady`:
  - `createAutostart(app.isPackaged, …).set(false)`;
  - `uninstallIntegration(resolveClaudeDir())`.

  It exits 0 on success and 2 if the integration removal failed. It never starts the daemon or a window.
- **The primary's `second-instance` handler** reads `parseInstanceMessage(additionalData)`:
  - `quit` → `app.quit()`, the clean `before-quit` path;
  - `show` from the same build, or an undefined message from an older build → `showOverlay()`;
  - `show` from a different build → nothing, because that instance shows the dialog itself.
- **The lock request** passes `additionalData`: `{ kind: 'show', build }` in normal mode, `{ kind: 'quit' }` otherwise.

- [ ] **Step 1: Write failing tests**
  - `instance.test.ts`:
    - `launchMode(['x.exe','--quit'])` is `'quit'`, `['x.exe']` is `'normal'`, and `['x.exe','--uninstall']` is `'uninstall'`.
    - `sameBuild` is true for paths that differ only in case and slash direction, and false when only `renderer` differs.
    - `describeBuild` gives the three texts.
    - `parseInstanceMessage` accepts both kinds and rejects `undefined`, `{kind:'show'}` without a build, and an unknown kind.
    - `parseInstanceRecord` rejects a non-integer or non-positive pid.
  - `instance-file.test.ts`:
    - the record round-trips;
    - reading a missing or broken file gives `undefined` and does not throw;
    - `removeInstanceRecord` leaves a file that names another pid. That file belongs to a newer instance.
  - `wait-for-exit.test.ts`, with fake timers and an injected `isRunning`:
    - it resolves `true` once `isRunning` turns false;
    - it resolves `false` after `timeoutMs`;
    - it checks immediately, so an already dead pid resolves without waiting.
  - **Review Focus 2:** `instance-file.test.ts` › `a record from a dead older instance does not block` asserts that `waitForExit` on a dead pid resolves `true` at once. The `--quit` flow then exits 1 only if the lock is still refused, which the report confirms in the code.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the modules and the `index.ts` flow** above. Keep the `index.ts` diff to moving the startup into `startApp()` plus the lock flow. Rerun the tests. Expected: PASS.
- [ ] **Step 4: Fix the spec bullet.** Run `pnpm verify` and stage, including the spec. Message: `feat(desktop): hand over between builds and quit on request`.

### Task 6: The NSIS installer: shortcut page, clean quit, uninstall

**Files:**
- Create: `apps/desktop/resources/installer.nsh`
- Modify: `apps/desktop/electron-builder.yml` (`nsis.include: resources/installer.nsh`, `createDesktopShortcut: false`, `createStartMenuShortcut: false`, `runAfterFinish: true`), `README.md` (installing, building the installer, the shared `userData`), `docs/backlog.md` (the `tray.ts` resources item marked done, like the other done items)

**Interfaces:**
- Consumes: the `--quit` and `--uninstall` launch modes and their exit codes (Task 5: 0 ok, 1 could not close, 2 integration removal failed); `${APP_EXECUTABLE_FILENAME}` and `${isUpdated}` from electron-builder's NSIS templates.
- Produces: HKCU `Software\ClaudeSwitcher\Installer`, with DWORD values `StartMenuShortcut` (default 1) and `DesktopShortcut` (default 0).

- [ ] **Step 1: Read the installed templates first.** In `node_modules/app-builder-lib/templates/nsis/` (`installer.nsi`, `assistedInstaller.nsh`, `uninstaller.nsh`, `include/allowOnlyOneInstallerInstance.nsh`), find:
  - which custom macro inserts a page into the assisted installer when the directory page is off;
  - where `customUnInstall` runs relative to the file removal;
  - what the default `customCheckAppRunning` does. Expected: it kills by process name, which we replace.

  Write the findings, with file and macro names, as comments at the top of `installer.nsh`.
- [ ] **Step 2: Write `installer.nsh`.**
  - **The shortcut page:** an nsDialogs page with the checkboxes `'Start menü parancsikon'` and `'Asztali parancsikon'`. Their initial state comes from HKCU, falling back to the defaults. In silent mode (`${Silent}`) the page is skipped and the HKCU values are used.
  - **`customInstall`:** create the chosen shortcuts (to `$INSTDIR\${APP_EXECUTABLE_FILENAME}`), delete an unchosen one if it exists, and write both values to HKCU.
  - **`customCheckAppRunning`:**
    - if `$INSTDIR\${APP_EXECUTABLE_FILENAME}` exists, run `ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit' $0`;
    - on a non-zero `$0`: `MB_RETRYCANCEL` with `'Nem sikerült bezárni a futó ClaudeSwitchert. Zárd be a tálcáról, aztán válaszd az Újra gombot.'`; in silent mode, abort;
    - never `taskkill`, never `nsProcess` kill.
  - **`customUnInstall`, only when `${isNot} ${isUpdated}`** (Review Focus 1):
    - `ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall' $0`, before the files are removed. If Step 1 shows `customUnInstall` runs too late, use the earlier hook it names;
    - on `$0 = 2`, a warning that the Claude Code integration could not be removed, and the uninstall continues;
    - delete both shortcuts and the HKCU key.

    `userData` is never touched (`deleteAppDataOnUninstall: false`).
- [ ] **Step 3: Build.** `pnpm --filter @claudeswitcher/desktop dist` exits 0, which means makensis compiled the include. Report the output name and size. In the generated script, or with `grep` in the electron-builder output, confirm that the default kill is not in the compiled path. Report how this was checked.
- [ ] **Step 4: Update README and backlog.** The README covers:
  - **building the installer:** `pnpm --filter @claudeswitcher/desktop dist` and the output path;
  - **installing:** per user, no admin rights, SmartScreen's "More info → Run anyway" because the installer is unsigned, and what the uninstaller removes and keeps;
  - **the shared `userData`:** the installed app and the repo builds share it, which is why the token and the hooks survive;
  - **one instance:** only one ClaudeSwitcher runs, and a different build asks before taking over.
- [ ] **Step 5:** Run `pnpm verify` and stage. Message: `feat(desktop): add the installer's shortcut page and clean quit`.

### Alex's live test (after Task 6, before the branch closes)

The lead writes the exact protocol from the spec's "Done when" steps 1–7. It also checks:
- the hotkey capture, with a taken combination (Review Focus 3);
- a tray toggle while the window has an unsaved edit (Review Focus 4);
- an upgrade by installing the same installer twice, after which the integration and autostart are still there (Review Focus 1).

Permission prompts in the protocol use `node -e` file writes, never `echo`.
