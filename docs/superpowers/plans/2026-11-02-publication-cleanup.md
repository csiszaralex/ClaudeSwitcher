# Publication Clean-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repo readable for a public audience: restructure the few overgrown modules, remove duplication, translate every non-GUI text to English, write the README and CONTRIBUTING, and move the working documents out of the tracked tree.

**Architecture:** No behaviour change. Logic leaves the Electron glue in `apps/desktop/src/main/index.ts` for small modules with injected dependencies and unit tests, the pattern the codebase already uses (`setup-window.ts`, `hotkey-capture.ts`, `settings-service.ts`). Shared facts get one home. The translation runs after the code moves, the docs after the translation, the archive last.

**Tech Stack:** Electron 45, electron-vite 6, React 19, TypeScript 6 strict, vitest, Nx, pnpm 12, knip.

**Spec:** `docs/superpowers/specs/2026-11-02-publication-cleanup-design.md`. The detailed findings each task cites (file, symbols, failure scenario, fix) are in the local recon reports `.superpowers/sdd/2026-11-02-cleanup-recon/srp.md` and `dry.md`, cited as "srp N" and "dry N". Read the cited section before starting the task. Where a report and the code disagree, the code wins: report it.

## Global Constraints

- No behaviour change: hook timing, the quit order, the hand-over, the hotkey and the installer behave exactly as today. A refactor that needs a behaviour change is out: stop and report.
- `pnpm verify` exits 0 at every commit. Strictness, `knip` and the ESLint rules stay as they are. No casts, non-null `!`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error` or synchronous child processes in non-test code.
- One independent change per commit: Conventional Commits, exactly one scope (`desktop`, `core`, `daemon`, `repo`), English, no AI attribution. A move and a translation never share a commit.
- The renderer imports values only from `@claudeswitcher/core/browser` and `src/shared/**`. A module goes into `/browser` only if it has no `node:` import.
- New and translated text carries no local data: no name, no real path, no real id. "measured live", "a test project".
- GUI strings stay Hungarian. Test data stays as it is (the `hook-payloads.json` fixture and the sample strings in tests).
- The Claude Code coupling points list stays correct after every move (in `CLAUDE.md` until Task 11, in `CONTRIBUTING.md` after).
- Agents never commit (they stop at `git add` with the exact file list), never launch Electron or the installer, never touch `~/.claude` or the registry, never run `pnpm install`/`add` without asking.

## Review Focus

1. **A sandboxed preload that imports a shared value chunk loads with no API** (srp 4): after Task 1, `out/preload` must hold only `index.cjs` and `setup.cjs`. Pinned by Task 1 Step 4.
2. **A quit request during startup, or a second one while stopping, must not start a second stop or skip the record removal:** pinned by Task 2's tests.
3. **A capture that ends while the held hotkey was taken by another app must report the fallback, not the old value:** pinned by Task 3's tests.
4. **An unknown lifecycle kind or a malformed hook body must get the same response as today after the hook-server refactor:** pinned by Task 7's test.
5. **A translation commit that changes a code token, a GUI string or test data:** pinned by Task 9's token check.

---

### Task 1: One IPC contract (srp 4, dry 1)

**Files:**
- Create: `apps/desktop/src/shared/overlay-channels.ts`, `apps/desktop/src/shared/setup-channels.ts`, `apps/desktop/src/main/ipc-handle.ts`, `apps/desktop/src/main/ipc-handle.test.ts`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/setup-window.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/preload/setup.ts`, `apps/desktop/src/renderer/setup-view.ts`, `apps/desktop/src/renderer/decision-actions.ts` (only the reply types)

**Interfaces:**
- Produces: `OVERLAY_CHANNELS` and `SETUP_CHANNELS`, `as const` objects with every channel name (invoke and push), plus the reply types `InstallReply = { ok: boolean; message: string }` (in `setup-channels.ts`) and `DecideOutcome` (in `overlay-channels.ts`, typed against the daemon's `DecideResult` with `import type`). Each preload imports only its own channels module.
- Produces: `handleFrom(page, channel, handler)` in `ipc-handle.ts`: registers `ipcMain.handle(channel, …)`, runs the existing per-page sender check (`isRendererSender`) once, logs a foreign sender with the channel name, and answers it as today (`FOREIGN_SENDER` behaviour moves here). `ipcMain` is injected as `{ handle }` so it is testable.

- [ ] **Step 1: Write the failing tests** in `ipc-handle.test.ts`: `it('calls the handler for the own page')`, `it('refuses a foreign sender without calling the handler, as today')` (assert the exact reply the current code gives a foreign sender), `it('registers each channel once')`.
- [ ] **Step 2: Run** `pnpm --filter @claudeswitcher/desktop test -- ipc-handle`: FAIL, module missing.
- [ ] **Step 3: Implement** the two channel modules and `handleFrom`, then replace every bare channel string in the files above. No handler body changes.
- [ ] **Step 4: Build and check the preload output:** `pnpm --filter @claudeswitcher/desktop build`, then `ls apps/desktop/out/preload`: exactly `index.cjs` and `setup.cjs`. Report the listing.
- [ ] **Step 5: Run `pnpm verify`** (foreground, timeout 600000): exit 0. Stage. Message: `refactor(desktop): name every IPC channel once`.

### Task 2: The quit sequence as a module (srp 1)

**Files:**
- Create: `apps/desktop/src/main/quit-sequence.ts`, `apps/desktop/src/main/quit-sequence.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Produces, exactly as srp 1 gives it: `QuitSequence { isQuitting(); setDaemon(daemon); setCleanup(cleanup); onBeforeQuit(event) }` and `createQuitSequence({ quit, stopWithin, removeRecord })`. `index.ts` creates it before `MODE`, so `let quitting` and its TDZ hazard disappear; every `isQuitting()` and `quitting` read goes through it; `recordedIn` folds into `removeRecord`.

- [ ] **Step 1: Write the failing tests:** `it('prevents the first before-quit and quits after the daemon stopped')`, `it('swallows a second before-quit while stopping')` (stop called once), `it('lets before-quit through once done')`, `it('removes the record only after the stop resolved or timed out')`, `it('still stops and quits when cleanup throws')`, `it('quits without a daemon when none was set')`.
- [ ] **Step 2: Run** the test: FAIL.
- [ ] **Step 3: Implement** and rewire `index.ts`. Keep the order cleanup, stop within `STOP_TIMEOUT_MS`, remove record, quit, and keep the `startApp` re-check after `startDaemon` (`fc7c7a3`).
- [ ] **Step 4: Run `pnpm verify`:** exit 0. Stage. Message: `refactor(desktop): move the quit sequence out of index.ts`.

### Task 3: The hotkey controller (srp 2)

**Files:**
- Create: `apps/desktop/src/main/hotkey-controller.ts`, `apps/desktop/src/main/hotkey-controller.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `registerHotkeyOrDefault`, `switchHotkey`, `HotkeySwitch` (`hotkey.ts`), `createHotkeyCapture`, `CAPTURE_SHORTCUTS` (`hotkey-capture.ts`).
- Produces, as srp 2 gives it: `HotkeyController { registration(); switchTo(next): HotkeySwitch; startCapture(); endCapture(); capturing() }` and `createHotkeyController({ register, unregister, configured, onFire, onRegistrationChanged, onCaptured, defer? })`. The setup window's `WindowCapture` becomes `{ active: c.capturing, end: c.endCapture }`.

- [ ] **Step 1: Write the failing tests** (the fake `register` from `hotkey-capture.test.ts`): `it('reports the fallback when the configured hotkey is taken at start')`, `it('ends a running capture before a switch')`, `it('keeps the held hotkey and reports it after a refused switch')`, `it('re-registers the held hotkey when a capture ends')`, `it('reports the fallback when the held hotkey was taken during a capture')`, `it('delivers a temporary-shortcut capture through defer')`.
- [ ] **Step 2: Run** the test: FAIL.
- [ ] **Step 3: Implement** and rewire `index.ts`. Keep the `hotkeyLogText` lines and the order "end capture before `globalShortcut.unregisterAll()`" in the quit cleanup.
- [ ] **Step 4: Run `pnpm verify`:** exit 0. Stage. Message: `refactor(desktop): move the hotkey state into a controller`.

### Task 4: The overlay window controller and shared window helpers (srp 3, dry 5)

**Files:**
- Create: `apps/desktop/src/main/overlay-window.ts`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/harden-window.ts` (+ its test), `apps/desktop/src/main/setup-window.ts`

**Interfaces:**
- Produces: `secureWebPreferences(preload: string)` and `loadPage(window, location: RendererLocation)` in `harden-window.ts`, used by both windows; `createOverlayController({ page, preload, isQuitting })` returning `{ show(), toggle(), hide(), isVisible() }`, with `sessionEnding` and one reload limiter per controller inside.

- [ ] **Step 1: Write the failing test** in `harden-window.test.ts`: `it('secureWebPreferences keeps contextIsolation, sandbox and no nodeIntegration')` with the exact object today's `createOverlay` passes.
- [ ] **Step 2: Implement**, two commits:
  - `refactor(desktop): share the secure window settings between both windows` (`harden-window.ts` + test, `setup-window.ts`, the `createOverlay` call site);
  - `refactor(desktop): move the overlay window into its own controller` (`overlay-window.ts`, `index.ts`). The `close` handler reads `isQuitting()` live.
- [ ] **Step 3: Run `pnpm verify`** for each commit's state (snapshots per `CLAUDE.md` "Munkamódszer" when two commits share a file): exit 0. Stage the first.

### Task 5: The broker reports who resolved a decision (srp 6)

**Files:**
- Modify: `packages/daemon/src/decision-broker.ts`, `packages/daemon/src/decision-broker.test.ts`, `packages/daemon/src/daemon.ts`

**Interfaces:**
- Produces: `DecisionChange.resolvedSessionId?: string`, set by `decide` → `#finish`; `DecisionBroker.pendingSinceBySession(): Map<string, number>`. `resolvingFor` in `daemon.ts` disappears.

- [ ] **Step 1: Write the failing tests:** `it('reports resolvedSessionId when the app decides')`, `it('pendingSinceBySession gives the oldest pending per session')`. Update the existing `toHaveBeenLastCalledWith({ abortedSessionId })` assertions for the new field.
- [ ] **Step 2: Run** the daemon tests: FAIL.
- [ ] **Step 3: Implement.** The same single synchronous emit inside `decide`.
- [ ] **Step 4: Run `pnpm verify`:** exit 0. Stage. Message: `refactor(daemon): report the resolving session from the broker`.

### Task 6: One home for shared test helpers (dry 2)

**Files:**
- Create: `packages/core/src/testing.ts` (dev-only subpath `@claudeswitcher/core/testing`, excluded from the build like `test-helpers.ts` is today; check how `package.json` `exports` and the tsconfigs treat it, and that knip accepts it)
- Modify: the 7 test files that load `hook-payloads.json`, the 3 `test-helpers.ts`, `packages/daemon/src/scanner.test.ts`, `packages/daemon/src/daemon.test.ts`

**Interfaces:**
- Produces: `tempDir()`, `hookPayload(name)` (throws `unknown fixture: <name>` for a missing name), `parsedPayload(name)` (throws `fixture <name> did not parse` only when it exists and fails), `fakeProbe(overrides)`, and the claude-dir fixture writers dry 2 names.

- [ ] **Step 1: Write** `it('hookPayload throws for an unknown name')` and `it('parsedPayload throws did-not-parse only for an existing fixture')` in `packages/core/src/testing.test.ts`.
- [ ] **Step 2: Implement**, then move every caller. Test titles and assertions stay. The test counts per package stay the same, plus the new tests.
- [ ] **Step 3: Run `pnpm verify`:** exit 0, and `pnpm --filter @claudeswitcher/desktop build` output contains no `testing` module. Stage. Message: `test(core): share the fixture and temp-dir helpers`.

### Task 7: Core and daemon duplications (dry 4, 6, 7, 9, 11, 12, 13)

One commit per item, in this order. Each follows the fix its dry section gives:

| Item | Commit message |
|---|---|
| dry 4: `truncate` in `guards.ts`, `ROW_TEXT_MAX = 80` | `refactor(core): flatten and truncate text in one place` |
| dry 6: `DAEMON_HOST`, `DAEMON_WS_PATH`, `DAEMON_WS_TOKEN_PARAM`, `daemonWsUrl` in core `protocol.ts`; a `renderer-csp.test.ts` check against `DAEMON_HOST` | `refactor(core): name the daemon address parts once` |
| dry 7: `displayRoute` in `hook-server.ts`, `LIFECYCLE_KINDS` from `HOOK_CONTRACT` | `refactor(daemon): register the display routes through one helper` |
| dry 9: `createToken()`, `isToken()` in the daemon, used by desktop `token.ts` | `refactor(daemon): own the token format` |
| dry 11: `projectsDir`, `subagentsDirOf`, `subagentMetaFile` in core | `refactor(core): keep the Claude Code file layout in one place` |
| dry 12: the two wrong timing comments (reword, do not change values) | `docs(core): correct the timing comments` |
| dry 13: `isRecord`, `errorCode`/`isMissingPathError`, `isHotkeyValue`, `REQUIRED_FIELD` from `tool-names.ts`, `optionalString` | one commit per package touched, scope by package: `refactor(<scope>): reuse the shared guards` |

- [ ] **Step 1 (dry 7, before the refactor): write** `it('answers an unknown lifecycle kind as today')` and `it('answers a malformed body as today')` in `hook-server.test.ts`, asserting today's status code and body. They pass before and after.
- [ ] **Step 2:** For each item, update the `CLAUDE.md` coupling points or module index line it affects in the same commit.
- [ ] **Step 3: Run `pnpm verify` per commit state:** exit 0. Stage per commit and stop for the lead after each.

### Task 8: Desktop duplications and the rename (dry 8, 10, 14, 15, srp 7, 10, 11)

One commit per item:

| Item | Commit message |
|---|---|
| dry 8: renderer fallback from `DEFAULT_SETTINGS.hideAfterLastDecision` | `refactor(desktop): take the overlay setting default from the settings list` |
| dry 10: `HELPER_FLAG = { quit: '--quit', uninstall: '--uninstall' }` in `instance.ts`, used by `index.ts`; a test reading `apps/desktop/resources/installer.nsh` that checks `CS_EXIT_*` and the `csRunHelper` flags | `test(desktop): check the installer against the launch contract` |
| srp 11: `errorMessage(error: unknown): string` helper | `refactor(desktop): describe errors through one helper` |
| dry 14: CSS variables in `styles.css` (`--accent`, `--danger`, `--bg`, …) | `refactor(desktop): name the overlay colours` |
| srp 7: `ACTION_BUTTONS` in `decision-actions.ts`, `JumpButton.tsx`, `DecisionContent.tsx`; `it('every shortcut has a button with that key')` | `refactor(desktop): build the decision buttons from one table` |
| dry 15: the config restatements | `chore(repo): drop restated config` |
| srp 10: `main/setup.ts` → `main/claude-integration.ts` (`git mv`, then the imports, `CLAUDE.md`) | `refactor(desktop): rename the hook integration module` |

- [ ] **Step 1:** For srp 7, write the shortcut test first; it fails until the table exists. Keep `disabled={busy || !armed}` per button exactly.
- [ ] **Step 2: Run `pnpm verify` per commit state:** exit 0. Stage per commit and stop for the lead after each.

### Live test (after Task 8, before Task 9)

The lead writes one exact protocol for Alex covering Tasks 1–8: overlay open and hide, hotkey and capture (including the Alt+Space family), a permission decision from the overlay with each button and its key, tray toggles and quit, `--quit`, a hand-over between `start` and the installed app, an install over the running app, and the setup window. Permission prompts use `node -e` file writes in the test project.

### Task 9: Translate every non-GUI text (spec B)

**Files:** every file `language.md` part 1 lists with Hungarian comments, `describe` titles or non-GUI log texts, one commit per area:

| Area | Commit message |
|---|---|
| `packages/core` | `docs(core): translate the comments to English` |
| `packages/daemon` | `docs(daemon): translate the comments to English` |
| `apps/desktop/src/main` | `docs(desktop): translate the main process comments to English` |
| `apps/desktop/src/{renderer,preload,shared}` and `electron.vite.config.ts` | `docs(desktop): translate the renderer comments to English` |
| root configs and `spikes/` (incl. the ESLint messages) | `docs(repo): translate the configs and spikes to English` |

- [ ] **Step 1:** Translate the meaning, drop comments that only restate the code, keep GUI strings and test data, write no local data.
- [ ] **Step 2: Token check** (Review Focus 5): after stripping comments, the commit changes nothing but `describe` titles and the non-GUI log texts `language.md` lists. Write the check as `scripts/check-comment-only-diff.mjs` (takes a git range, strips `//` and `/* */` comments and the listed string literals with the TypeScript scanner, compares tokens, exits 1 on a difference) and run it per commit. Report its output.
- [ ] **Step 3:** Rerun the language inventory from `language.md` (the scratchpad script) for the area: 0 Hungarian comment lines. Report.
- [ ] **Step 4: Run `pnpm verify`:** exit 0. Stage per area.

### Task 10: README and CONTRIBUTING (spec C)

**Files:** `README.md`, create `CONTRIBUTING.md`

- [ ] **Step 1: `README.md`,** English, three layers per the spec: motivation; use (install from source until part 5, first start, what you see, Hungarian GUI, Windows and Claude Code in VS Code); development (a pointer to `CONTRIBUTING.md`). Leave a marked placeholder for Alex's screenshot or GIF.
- [ ] **Step 2: `CONTRIBUTING.md`,** per the spec: running from the repo, the architecture (packages, and how a hook travels to the overlay and back), the rules, the module index, the coupling points list, the code-relevant environment notes.
- [ ] **Step 3:** Every command and path in both files is checked against the repo. Stage. Messages: `docs(repo): rewrite the README for new users`, `docs(repo): add the contributing guide`.

### Task 11: CLAUDE.md, CLAUDE.local.md, the design (spec C)

- [ ] **Step 1:** `CLAUDE.md` in English, short, pointing to `CONTRIBUTING.md`; the personal workflow and the machine facts to `CLAUDE.local.md`; add `CLAUDE.local.md` to `.gitignore`. Message: `docs(repo): split the agent rules from the personal workflow`. (`CLAUDE.local.md` is untracked: say so in the report.)
- [ ] **Step 2:** `git mv docs/superpowers/specs/2026-09-04-claudeswitcher-design.md docs/design.md` and update the references: `docs(repo): move the main design to docs/design.md`.
- [ ] **Step 3:** Translate `docs/design.md` and `spikes/m2-permission/RESULTS.md`: `docs(repo): translate the design and the spike results`.
- [ ] **Step 4: Run `pnpm verify`** per commit: exit 0. Stage per commit.

### Task 12: Archive the working documents (spec D)

- [ ] **Step 1:** Add `docs/archive/` to `.gitignore`. Move (on disk) and untrack (`git rm --cached`): `docs/superpowers/plans/`, `docs/superpowers/specs/`, `docs/reviews/`, `docs/backlog.md`, `spikes/m2-permission/SCENARIO.md`, into `docs/archive/` keeping their relative layout.
- [ ] **Step 2:** `grep` the tracked tree for every moved path (and "backlog item"): none left, or reworded. Report the grep.
- [ ] **Step 3: Run `pnpm verify`:** exit 0. Stage. Message: `docs(repo): move the working documents out of the tree`.
