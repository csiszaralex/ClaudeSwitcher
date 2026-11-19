# Contributing to ClaudeSwitcher

This guide is for developers who want to run, change or trace the code. What the app does for a user is in [`README.md`](README.md). The design, and the measured Claude Code behaviour it depends on, is in [`docs/design.md`](docs/design.md). The raw measurements of the permission hook are in [`spikes/m2-permission/RESULTS.md`](spikes/m2-permission/RESULTS.md).

## Running from the repository

Prerequisites: Windows, Node.js 24 or newer (`engines` in `package.json`), and pnpm at the version pinned in `packageManager` (`corepack enable` provides it).

```sh
pnpm install
pnpm build
pnpm --filter @claudeswitcher/desktop start
```

- `pnpm install` also runs the root `prepare` script, which installs the git hooks (see [Checks](#checks)).
- `pnpm build` builds every package. The desktop app bundles `@claudeswitcher/core` and `@claudeswitcher/daemon` from their `dist/` output, so build them again after changing either of them (`pnpm --filter @claudeswitcher/core build`, or `pnpm build`).
- `start` is `electron-vite preview`: it builds the app and starts the built version. For live reloading of the renderer use `pnpm --filter @claudeswitcher/desktop dev` (`electron-vite dev`).
- The Electron binary does not come with `pnpm install`: the `electron` package has no install script. The desktop `predev`, `prestart` and `predist` scripts run its `install-electron` command first, which downloads the binary once and does nothing after that. Building and `pnpm verify` do not need it.

### Building the installer

```sh
pnpm install
pnpm build
pnpm --filter @claudeswitcher/desktop dist
```

`dist` builds the app and the Windows installer into `apps/desktop/release/`: `ClaudeSwitcher-Setup-<version>.exe`, its `.blockmap` and `latest.yml` (NSIS, configured in `apps/desktop/electron-builder.yml` and `apps/desktop/resources/installer.nsh`). A local build has the repo's version, `0.0.0`, and uploads nothing (`--publish never`). An installer built on your machine carries no download mark, so SmartScreen does not warn about it. Its in-app update works like a released one: it finds the latest GitHub release and offers it in the tray (**"Frissítés a/az <version> verzióra"**), and a click on that item replaces the test build with the release.

### One instance at a time, and the hand-over

Only one ClaudeSwitcher runs at a time, installed or started from the repo: the daemon listens on a fixed port (`DAEMON_PORT`, 47821, in `apps/desktop/src/main/daemon-port.ts`), and the installed hooks point there. The rules live in `apps/desktop/src/main/index.ts` (`handOverOrQuit`, `runHelper`) and `apps/desktop/src/main/instance.ts` (`sameBuild`, `instanceAction`):

- The same build started again quits silently, and the running one shows its list.
- A different build (for example `start` while the installed app runs; `dev` and `start` count as different builds too) asks "Már fut egy ClaudeSwitcher (…). Bezárjam, és ez induljon?" ("ClaudeSwitcher is already running. Close it and start this one?"). On "Bezárás és indítás" it starts a `--quit` helper of itself, the running app quits through its normal quit sequence (its daemon releases the held requests), and the new one takes over within `HANDOVER_TIMEOUT_MS`.
- The running app writes `instance.json` to `userData` (`instance-file.ts`), so another build knows which build holds the lock.

The installer and the uninstaller use the same helper modes, `--quit` and `--uninstall`, with the exit codes in `LAUNCH_EXIT_CODE`. They never kill a process.

### Shared data

The installed app and every repo build use the same `userData` directory, `%APPDATA%\@claudeswitcher\desktop` (`apps/desktop/src/main/user-data.ts` `userDataDir`). It holds `config.json` (the settings, which of them the user confirmed, and the update version the user skipped), `daemon-token`, `instance.json` and the `logs` folder (the log file, see `main/log-file.ts`). Because the token is shared, hooks installed by one build keep working with the others. Start at login and checking for updates work only in the installed app, so both are read-only in a repo build: the login item would register `electron.exe` (`autostart.ts`), and the updater is created only when `app.isPackaged` (`index.ts`). The list is `INSTALLED_ONLY_SETTINGS` in `apps/desktop/src/shared/settings.ts` (`isInstalledOnly`).

### Environment variables

- `CLAUDE_CONFIG_DIR`: Claude Code's configuration directory, `~/.claude` when unset (core `paths.ts` `resolveClaudeDir`). The app reads sessions from it and installs the hooks into its `settings.json`.
- `CLAUDESWITCHER_HOOK_LOG=<file>`: when set at start-up, the daemon appends the raw body of every hook it receives to this file as one JSON line (`hook-server.ts` `createHookApp`). Off by default. The bodies contain prompts, commands and file contents.
- `CS_PROBE_MEASURE=1`: enables the manual process probe measurement (`apps/desktop/src/main/process-probe.measure.test.ts`), which is skipped otherwise. From Git Bash: `CS_PROBE_MEASURE=1 pnpm --filter @claudeswitcher/desktop test process-probe.measure`.

## Architecture

A pnpm workspace with Nx, all TypeScript:

| Package | Owns |
|---|---|
| `packages/core` | Session discovery (registry and IDE lock parsing, process liveness), transcript reading, the decision model (classifying a permission request, building the hook response), the hook contract, the settings file writer. Two entry points: the main one (Node) and `@claudeswitcher/core/browser` (no `node:` imports, for the renderer). A third, `@claudeswitcher/core/testing`, holds the shared test helpers and is used by tests only. |
| `packages/daemon` | The HTTP hook server, the WebSocket hub, the poll that re-reads sessions and transcripts, the session store and the `DecisionBroker`, which owns the held permission requests. |
| `apps/desktop` | The Electron app: `main` (tray, global hotkey, windows, window focus, Claude Code integration, start-up and quit), `preload` (one per window), `renderer` (React: the overlay and the setup window), `shared` (code both main and renderer compile, such as the settings list and the IPC channels). |

The daemon runs inside the Electron main process, not as a separate process; the package boundary is there so it could be moved out.

### How a permission request travels

1. **Claude Code fires a hook.** The integration (`apps/desktop/src/main/claude-integration.ts`) installed one HTTP hook per event in `HOOK_CONTRACT`. Each posts the hook payload to `http://127.0.0.1:<DAEMON_PORT>/hooks/<route>` with `Authorization: Bearer $CLAUDESWITCHER_TOKEN`; Claude Code substitutes the token from `env.CLAUDESWITCHER_TOKEN`.
2. **The hook server checks the token.** `packages/daemon/src/hook-server.ts` `createHookApp` (Hono, loopback only) rejects a request without the right bearer token with a 401 (`token-compare.ts` `matchesSecret`, a constant-time comparison). Every display-only route answers an empty 200, whatever happens.
3. **The request is held.** On `/hooks/permission-request` the body is parsed by core `decision.ts` `parsePermissionRequest`, which also classifies it (`tool`, `edit`, `question`, `plan`). `DecisionBroker.hold` (`decision-broker.ts`) keeps the HTTP response open. The other hooks (`Notification`, `Stop`, `PreToolUse` and so on) update the `SessionStore` (`session-store.ts`) and tell the broker about decisions made elsewhere.
4. **The overlay learns about it.** `daemon.ts` broadcasts the state (sessions plus pending decisions) through the `Hub` (`hub.ts`), a WebSocket on `/ws` that checks the token before the handshake. The renderer gets the port and token over IPC (`daemon:connection`), connects with `daemonWsUrl` (`useDaemonState.ts`) and drops any message whose `protocol` is not `DAEMON_PROTOCOL` (`state-message.ts`).
5. **The user decides.** The decision panel (`DecisionPanel.tsx`) sends the decision over IPC (`decision:decide`, `preload/index.ts`). The main process checks the sender (`ipc-handle.ts` `createHandleFrom`), validates the decision (core `decision-response.ts` `parseUserDecision`) and calls the daemon's `decide`.
6. **The hook gets its answer.** `DecisionBroker.decide` builds the hook response with core `decision-response.ts` `buildHookResponse` (`allow` or `deny`, with `updatedInput` or `updatedPermissions` where needed) and resolves the held request, so the hook server returns it as the HTTP response.

The native prompt in VS Code is open the whole time, and the first decision wins. The broker learns about a decision made in VS Code from `PostToolUse` or `PostToolUseFailure` (matched through the `tool_use_id` of the preceding `PreToolUse`), from the hook connection being closed (the native "No" or Esc), or from the end of the turn (`Stop`, `SessionEnd`, `SubagentStop`). The still-pending request then gets an empty 200, which Claude Code ignores. A request nobody decides is released with an empty 200 after `PERMISSION_RELEASE_AFTER_MS`, and on quit `releaseAll` answers every held request before the server closes. Any error in this path is also an empty 200: Claude Code treats that as "no decision", never as a denial.

Session discovery runs alongside: every `POLL_INTERVAL_MS`, and after every `Stop`, `StopFailure` and `SessionEnd`, `daemon.ts` `refresh` calls `scanner.ts` `scanSessions`, which reads the session registry, the IDE lock files and the transcript tails (core `transcript.ts` `readTranscriptActivity`: the last 256 KB, and for a turn that outgrew them, the lines that may concern a cross-session message back to the turn's start).

## Rules

### Strictness

- TypeScript runs with the strictest settings (`tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `noUnusedLocals` and the rest. Tests are type-checked too (each package's `tsconfig.check.json`, desktop `tsconfig.web.test.json`).
- ESLint (`eslint.config.mjs`) uses typescript-eslint `strictTypeChecked`, plus `switch-exhaustiveness-check` and `eqeqeq`.
- `knip` reports dead code, unused exports of entry points included.
- Do not loosen any of these without a reason that holds up in review.

### Checks

```sh
pnpm verify
```

runs `check-types`, `lint`, `test` and `build` for every package (Nx), then type-checks and lints the root configs and `scripts/`, then runs `knip`. It must exit 0 before anything is merged into `main`. The Windows-only live tests are skipped visibly on other platforms, and the one that needs a running VS Code window is skipped without one.

The git hooks (`simple-git-hooks`, installed by `pnpm install`):

- **pre-commit:** `pnpm verify:commit`, the fast check: type checks and lint for the packages the uncommitted changes touch (`nx affected --uncommitted`), then `knip`.
- **pre-push:** the full `pnpm verify`.

Do not skip them (`--no-verify`).

CI (`.github/workflows/verify.yml`) runs the same `pnpm verify` on a Windows runner for every push and pull request to `main`.

For a change that should only touch comments (a translation, for example), `pnpm check:comment-only -- <base>` (`scripts/check-comment-only-diff.mjs`) compares the token streams of every changed source file and fails on any change outside comments, test titles and the strings listed in an optional `--allow` file. The usage is at the top of the script.

To find out which process shows a window that flashes up (a console during a test run, for example), `scripts/measure/window-watch.ps1` logs every top-level window shown, with its class, title, process, parent process and command line, read only. The usage is at the top of the script; the log goes to `%TEMP%` by default.

To see what a window title shows while you switch tabs and windows, `scripts/measure/title-watch.ps1` logs, read only, every foreground change and every title change of a top-level window of one process (`Code` by default), with whether that window is in the foreground. The usage is at the top of the script; the log goes to `%TEMP%` by default.

To see how the sessions message each other, `node scripts/measure/cross-session.mjs [days]` links, read only, every `SendMessage` of the last days' transcripts to its arrival in the recipient's transcript, and prints per sender and recipient how many messages went, how many got a reply, and how long the sender showed finished while the recipient still worked. It prints session names and counts, never message text.

### Code

- **No synchronous child processes** (`execSync`, `execFileSync`, `spawnSync`) outside tests. They stop the Electron main thread, and with it the daemon and every session's hooks. ESLint enforces this.
- **The renderer imports values only from `@claudeswitcher/core/browser`.** From `@claudeswitcher/core` and `@claudeswitcher/daemon` it may import types only; ESLint enforces this, and the renderer's tsconfig has no Node types. A core module may be exported from `/browser` only if it imports no `node:` module.
- **One fact in one place.** Every value, rule or constant lives in exactly one module, and everything else imports it. The shared homes are listed in the [module index](#module-index). Before adding a constant, look for its existing home.
- **GUI texts are Hungarian; everything else is English** (identifiers, comments, logs, non-GUI errors, docs).
- **Invented data in tests.** No real transcript content or local data (session ids, folder names, user names, tokens) in fixtures or tests. Use invented, well-formed values, such as a fresh UUID, `p:\proj\alpha` or `pidDomain: 'win32:user'`, and keep the measured shape. The measured hook payloads live in `packages/core/fixtures/hook-payloads.json`; tests load them through `@claudeswitcher/core/testing` (`hookPayload`, `parsedPayload`).

### Commits

[Conventional Commits](https://www.conventionalcommits.org/) with exactly one scope, in English, one independent change per commit. The scopes in use are `core`, `daemon`, `desktop`, `repo` and `deps`. For example: `fix(daemon): release held requests before the server closes`.

### Releases

Every push to `main` (a merged PR) runs `.github/workflows/release.yml`. Nx release (`nx.json` `release`) looks at the commits since the last `v*` tag that touch the desktop app or a package it bundles (a commit that changes only `.github/`, `scripts/` or the docs never releases):

- `feat` gives a minor bump, `fix` a patch bump, a breaking change (`!` or `BREAKING CHANGE:`) a major bump. `docs`, `test`, `chore`, `ci`, `refactor`, `build` and `style` give no release, and the run ends green without one. A squash merge leaves one commit, the PR title: it must then be a Conventional Commit too, or the merge releases nothing.
- The version source is the git tag (`v0.1.0`, …). The workflow writes the version into `apps/desktop/package.json` only in its own checkout; nothing is committed back, so the repo keeps `0.0.0`.
- The order is `pnpm verify`, the version, the installer build, then the tag, the GitHub Release with the notes Nx writes from the commits, and the upload of the installer, its `.blockmap` and `latest.yml`. A red `verify`, a failed build or a missing installer file leaves no tag. Only the tag is pushed, so a merge that lands during the run does not break it. If a step after the tag fails, delete the Release (if any) and the tag by hand, then rerun the workflow run of the latest commit on `main`. With the tag still there, a rerun finds nothing to release and ends green.

## Module index

The shared modules, each the one home of its facts. Core modules marked "/browser" are also exported by `@claudeswitcher/core/browser`.

**Core (`packages/core/src/`):**

- `hook-contract.ts` (/browser): the installed hooks (`HOOK_CONTRACT`), their routes and timeouts, the release time computed from the 600 s permission timeout (`PERMISSION_RELEASE_AFTER_MS`), the retired hooks (`LEGACY_HOOK_CONTRACT`), and the `lifecycle/*` kinds (`isLifecycleKind`, `lifecyclePath`).
- `timings.ts`: the timings several modules use (`POLL_INTERVAL_MS`, `PROBE_TTL_MS`). It imports nothing from Node, but `/browser` does not export it.
- `protocol.ts` (/browser): the contract between the daemon and the renderer: the protocol version (`DAEMON_PROTOCOL`) and the daemon's address (`DAEMON_HOST`, `DAEMON_WS_PATH`, `DAEMON_WS_TOKEN_PARAM`, `daemonWsUrl`). The renderer CSP (`apps/desktop/src/csp/renderer-csp.ts`) keeps the host as its own literal, and its test ties it to `DAEMON_HOST`.
- `guards.ts` (/browser): input guards (`isRecord`, `nonEmptyString` and others), and flattening text to one line and truncating it (`flatText`, `truncate`).
- `tool-names.ts` (/browser): the tool name sets (edit tools, command tools) and the Bash tool's name (`BASH_TOOL`). `decision.ts` picks each tool's required field from them (`requiredField`).
- `decision.ts` (/browser): parsing and classifying a permission request (`parsePermissionRequest`) and the decision kinds (`DecisionKind`).
- `usage-limit.ts` (/browser): Claude Code's usage limit record in the transcript: its field names (`usageLimitOf`, which `transcript.ts` `readActivityFromLines` calls) and the known limit kinds (`USAGE_LIMIT_KIND`: `five_hour`, `seven_day`). The measurement: `docs/design.md` "The usage limit record".
- `tab-title.ts`: the transcript records that name a session's tab in the VS Code extension (`custom-title` and `ai-title`, their field names) and which one the tab shows (`shownTabTitle`: the custom title wins); `transcript.ts` `readActivityFromLines` keeps the result as `SessionActivity.tabTitle`. The measurement: `docs/design.md` "The window title and the tab title".
- `cross-session.ts`: the transcript records of a cross-session message in the recipient's transcript (the `enqueue` arrival with its `<cross-session-message from="uds:…">` tag, the delivery by a `user` record or a `queued_command` attachment with a `peer` origin) and of the end of the turn that handles it (`isTurnEnd`), the cheap line pre-filter (`mayConcernPrompts`), and which senders are pending (`createPromptTracker`: from the arrival until that turn's end, one entry per sender, the pipe without `uds:`); `transcript.ts` `readActivityFromLines` keeps the result as `SessionActivity.promptedBy`, and `readTranscriptActivity` reads back past the tail for a turn that outgrew it (`PROMPT_LOOKBACK_BYTES`). The measurement: `docs/design.md` "Cross-session messages".
- `paths.ts`: the locations under Claude Code's configuration directory (`resolveClaudeDir`, `sessionsDir`, `ideDir`, `userSettingsPath`, `projectsDir`, `subagentsDirOf`).
- `testing.ts` (the `@claudeswitcher/core/testing` entry, tests only): the fixture loader (`hookPayload`, `parsedPayload`), `tempDir`, the fake process probe (`fakeProbe`) and a fake session record writer (`writeSessionRecord`).

**Daemon (`packages/daemon/src/`):**

- `token.ts`: the token format (`createToken`, `isToken`); the desktop app's `token.ts` uses it.

**Desktop (`apps/desktop/src/`):**

- `main/daemon-port.ts`: the daemon's fixed port (`DAEMON_PORT`). A module without imports, because the build config reads it too.
- `main/instance.ts`: the helper flags (`HELPER_FLAG`) and exit codes (`LAUNCH_EXIT_CODE`) that `resources/installer.nsh` repeats as literals; `instance.test.ts` checks that the two agree.
- `shared/settings.ts`: the one list of user settings (`SETTINGS`, `DEFAULT_SETTINGS`, `DEFAULT_HOTKEY`), including `checkForUpdates`, which `main/updater.ts` follows, and the two notification switches (`notifyOnRequest`, `notifyOnFinish`), which `main/index.ts` passes to `main/notifier.ts`.
- `main/updater.ts`: the in-app update of the installed app on electron-updater (`createUpdateController`): the check interval (`UPDATE_CHECK_INTERVAL_MS`), the tray's one update item, its states and labels (`UpdateItem`, `updateItemLabel`: the manual check `checkNow` or the install of a downloaded update), the update popup's texts and choices (`updatePrompt`, `updateChoice`), the manual check's boxes (`updateNotice`), when the popup and the boxes appear and what a skipped version (`config.ts` `saveSkippedVersion`) suppresses, and why `quitAndInstall` goes through the normal quit sequence and the installer's `--quit` helper (the comment in `install`).
- `main/log-file.ts`: the log of the main process (`installFileLog`, `ensureLogFile`): its folder and file names (`logDir`, `logFilePath`, `OLD_LOG_FILE_NAME`), the size limit (`LOG_MAX_BYTES`), the line format and the rotation. It wraps `console.log`, `console.warn` and `console.error` once, from `index.ts`, so no call site changes; the renderer's console is not captured. The tray's "Napló megnyitása" opens the file.
- `shared/request-source.ts`: where a session, and so each of its requests, comes from: the label of a registry `entrypoint` and whether it stands out (`requestSource`, the one home of the label texts and of the "stands out" rule), the host word of the texts that send the user to the session's own prompt (`sessionHost`: VS Code, the terminal or the session itself; `renderer/session-marker.ts` `releasedMessage`, `outsideAppMessage` and `unreadableMessage`, `JumpButton`, `PlanPanel`, `DecisionContent` and `RuleEditor` build their sentences from it; the core's and the daemon's refusal texts name no host, so this stays the one home of that wording), and the panel's folder and permission mode line (`requestFacts`). The renderer and `main/notifier.ts` both use it; `renderer/SourceLabel.tsx` draws the label the same way on the decision panel and in the status bar.
- `shared/hungarian-text.ts`: the generic helpers of the Hungarian texts: the definite article before a number (`numberArticle`: "a" or "az"), for the update item's version (`main/updater.ts` `updateItemLabel`) and the rule editor's line number (`renderer/rule-editor.ts` `unparsableLineText`), and the upper-case start of a sentence (`capitalized`), for the host word (`renderer/session-marker.ts` `releasedMessage` and `outsideAppMessage`) and that article.
- `shared/row-text.ts`: the one-line, clipped text of a row (`clip`, the 80 character limit) and of a pending request (`pendingRowText`). `renderer/format.ts` and the notification body (`main/notifier.ts`) use it.
- `main/notifier.ts`: which toasts a state change deserves (`createNotifier`): a new permission request by its decision `id`, a new `stoppedAt` of a session once it waits on no session it prompted (`waitsOn`), nothing at the first tick, nothing while the overlay is visible, each kind behind its setting (`notifyOnRequest`, `notifyOnFinish`), and the title and body texts. Pure; `main/toast.ts` shows the result with Electron's `Notification`, and `main/index.ts` runs it in the tray's one-second tick. `main/app-id.ts` holds the Application User Model ID (`APP_USER_MODEL_ID`, equal to `appId` in `electron-builder.yml`, which its test checks).
- `shared/request-kind.ts`: which decision kinds ask for a choice rather than a yes or a no (`isChoiceKind`: a question or a plan), which the list's dot (`renderer/session-marker.ts`) and the tray icon (`main/tray-state.ts`) colour, both through `shared/session-state.ts`.
- `shared/session-state.ts`: the first steps of the list's marker order that the tray shows too (`sessionState`: a choice, a yes/no, only released requests, working, waiting on the sessions it prompted, or none of these), from a session's status, its own requests and whether it waits on others (`shared/session-finished.ts` `waitsOn`). `renderer/session-marker.ts` `statusMarker` and `main/tray-state.ts` `trayState` both follow it.
- `main/tray-state.ts`: what the tray shows, from the daemon's state (`trayState`): how many sessions wait, the strongest wait across the rows (`sessionState` per session; a choice, a yes/no, else only released requests), how many sessions work (a session that waits on the sessions it prompted counts as working), how many sessions finished unseen (`finishState` of `shared/session-finished.ts`), and whether a held request is older than `PERMISSION_WARN_AFTER_MS` (the flash; the warning time, 50 s before core's `PERMISSION_RELEASE_AFTER_MS`, lives here), and the tooltip (`trayTooltip`). Pure; `main/index.ts` runs it in the tray's one-second tick and passes the result to `main/tray.ts` `setState`.
- `renderer/rows.ts`: the list's rows and their order (`buildRows`): the groups by marker tone (`TONE_RANK`, from the tone `renderer/session-marker.ts` `statusMarker` gives), the longest wait first in the two waiting groups (`compareWaitStart`, which `renderer/selection.ts` also uses to preselect: the oldest held, not released request's `createdAt`, else the daemon's `waitingSince`), the working group by name (its activity changes all the time), the group that waits on the sessions it prompted right after it (`Row.waitsOn`, the names `renderer/format.ts` `waitsOnText` shows; `Row.promptedBy`, the note `promptedByNote` puts before a recipient's text), the most recent activity first in the others. The daemon's own order of the sessions (`session-store.ts` `views`, by session id, only to keep the snapshot deterministic for the identical-snapshot filter in `daemon.ts` `broadcast`) does not reach the list.
- `shared/prompt-links.ts`: the links between the sessions that cross-session messages make (`recipientsOf`: the live sessions that work or wait and whose `activity.promptedBy` names a session's `messagingSocketPath`; `promptersOf`: the names of the senders a working session works for, the live row name first, else the name the message gave). One step only, so a mesh of sessions that prompt each other has no loop.
- `shared/session-finished.ts`: which sessions a finished session waits on (`waitsOn`: while its turn has ended, its recipients from `shared/prompt-links.ts`), when a session counts as just finished (`hasFinished`: not while it waits on any), and the one rule of a seen finish (`acknowledgeFinish`, per session and `stoppedAt`, never while it waits on others; `finishState`: `none`, `unseen` or `seen`), which the list's ✓ marker (green unseen, blue seen, `renderer/session-marker.ts`) and the tray's done mark (`main/tray-state.ts`) both follow. `main/index.ts` records a seen finish whenever the session is opened from the overlay (`focusSession`), whether or not a window comes to the front, and when its VS Code tab stays in front (`main/seen-elsewhere.ts`), in memory only, and hands the map to the overlay over `OVERLAY_CHANNELS.finishesSeen` (`renderer/useSeenFinishes.ts` reads it on load and on every `shown`).
- `main/seen-elsewhere.ts`: when a finish counts as seen because the session's VS Code tab is in front (`createSeenWatch`): whether the foreground window title shows a session's tab title (`showsTabTitle`: as a whole piece, `showsWhole`, or cut with `…` and matched by prefix, never parsed by position or separator), which session that is (`sessionInFront`: an extension session of the window's process, the only one with that title, the workspace folder's name deciding between several, and its finish unseen, so not while it waits on the sessions it prompted), the dwell (`SEEN_DWELL_MS`) and the poll (`SEEN_POLL_MS`), and when the poll runs (`watchesSeen`). Pure; `main/index.ts` (`watchSeen`) polls `main/focus-window.ts` `readForegroundTitle` with its own timer, which the tray tick starts and which stops itself, skips the poll while the overlay is up, and calls `acknowledgeFinish`. The measurement: `docs/design.md` "The window title and the tab title".
- `main/tray-icon.ts`: the tray icon, drawn at runtime (`trayLook`, `trayIconPixels`, `trayIconPng`, 16x16), the flash frame, and the one home of its colours (`TRAY_COLORS`). `main/tray.ts` alternates the flash frame with the normal icon on each tick. The colours the list shows too equal its CSS variables in `renderer/styles.css`, and the idle icon equals `resources/tray.png`, the source of the app icon (`scripts/make-icon.mjs`); `tray-icon.test.ts` checks both.
- `main/focus-window.ts`: the jump to a session's window (`focusSessionWindow`): which way each session goes (`focusWith`, `FocusOutcome`), the VS Code paths (`findMainWindow`, the `code` CLI), the terminal path (`ancestorChain`, `findTerminalWindow`, the console window classes `PSEUDO_CONSOLE_CLASS` and `CLASSIC_CONSOLE_CLASS`, `MAX_ANCESTORS`) and when the tab URI may be sent (`tabFocusUri`). The terminal path reads the process tree from `main/process-probe.ts` `takeProcessTree`, the same Toolhelp32 list the native probe uses. It also reads and restores the window that was in front before the overlay opened (`previousWindowOf`, `SHELL_WINDOW_CLASSES`, `canGiveBack`, `captureForeground`, `giveBackForeground`, through the same `bringToFront`), and reads the foreground window's title for `main/seen-elsewhere.ts` (`foregroundTitleOf`, `readForegroundTitle`, `ForegroundTitle`).
- `main/focus-return.ts`: when the focus goes back to that window (`createFocusReturn`): remembered when the overlay opens, before it shows (`main/overlay-window.ts` `show`), given back before hiding and only while the overlay has the focus, on `dismiss` (Esc and the hide after the last decision through `OVERLAY_CHANNELS.hide`, the hotkey through `toggle`); never after the jump or a blur.
- `shared/entrypoint.ts`: the registry `entrypoint` values the app knows (`VSCODE_ENTRYPOINT`, `CLI_ENTRYPOINT`, `HEADLESS_ENTRYPOINT`); `main/focus-window.ts`, `main/seen-elsewhere.ts` and `shared/request-source.ts` use them.
- `renderer/usage-limit.ts`: the usage limit in the overlay: when a row shows it (`sessionUsageLimit`: the session is idle and its transcript reported a limit, `SessionActivity.usageLimit`; `renderer/session-marker.ts` `statusMarker` gives it the `limit` tone, `renderer/format.ts` `summarize` its text), the row's text (`usageLimitRowText`) and the status bar's note (`usageLimitStatusText`: the limit that resets last), the local `H:mm` clock and the Hungarian weekday names. Pure; the times follow App's one-second clock.
- `renderer/git-explain.ts`: the plain Hungarian line of each git call in a Bash request's command, which `DecisionContent` shows (`gitExplanation`): how the command is split into calls and words the way bash would (quotes, substitutions, here-documents and redirections), which subcommands and flags it knows, their texts, and which of them are dangerous (`GitLevel`; the level of the hedged `git checkout <name>` line is `CHECKOUT_NAME_LEVEL`). Pure; a call it cannot classify with confidence gets no line.
- `shared/overlay-channels.ts`, `shared/setup-channels.ts`: the IPC channel names and reply types of the two windows.

## Claude Code coupling points

The app reads several undocumented Claude Code internals. If Claude Code changes, start here:

| Internal | Where it is read |
|---|---|
| `~/.claude/sessions/<pid>.json` (the live session registry) | core `session-registry.ts` `parseSessionRecord`, read in daemon `scanner.ts`. A record that lacks a required field is dropped silently. |
| The registry `pid` as the session's own `claude` process, whose parent is the shell of a terminal session | daemon `session-store.ts` `views` (`SessionView.pid`), desktop `main/focus-window.ts` (`ancestorChain`, `findTerminalWindow`). The measurement: `docs/design.md` "Mapping to terminal windows" |
| `procStart` (the process creation FILETIME as a decimal string) and process liveness | core `liveness.ts` (`ProcessProbe.isAlive`, `parsePowerShellSnapshot`), desktop `main/process-probe.ts` |
| `~/.claude/ide/<port>.lock` and the VS Code process image names | core `session-registry.ts` `parseIdeLock`, `liveness.ts` `VSCODE_IMAGE_NAMES` |
| The transcript, `projects/<encoded cwd>/<sessionId>.jsonl`, and the shape of its blocks | core `paths.ts` `projectsDir`, `transcript.ts` (`findTranscriptPath`, `readActivityFromLines`), `tool-detail.ts` |
| The usage limit record in the transcript (`isApiErrorMessage`, `quotaLimits` or `apiErrorParams.rate_limit_info`, `status: 'rejected'`, `resetsAt`, `rateLimitType`) | core `usage-limit.ts` (`usageLimitOf`, `USAGE_LIMIT_KIND`), `transcript.ts` `readActivityFromLines`; renderer `usage-limit.ts` (the `rateLimitType` values through `USAGE_LIMIT_KIND`). The measurement: `docs/design.md` "The usage limit record" |
| The tab title records in the transcript (`custom-title` with `customTitle`, `ai-title` with `aiTitle`; the custom one wins) | core `tab-title.ts` (`titleRecordOf`, `shownTabTitle`), `transcript.ts` `readActivityFromLines` (`SessionActivity.tabTitle`). The measurement: `docs/design.md` "The window title and the tab title" |
| The registry `messagingSocketPath` (the session's named pipe for cross-session messages) | core `session-registry.ts` `parseSessionRecord` (`SessionRecord.messagingSocketPath`), daemon `session-store.ts` `views` (`SessionView.messagingSocketPath`), desktop `shared/prompt-links.ts` (compared with the senders' pipes). The measurement: `docs/design.md` "Cross-session messages" |
| The cross-session message records in the recipient's transcript (`queue-operation` `enqueue` with `<cross-session-message from="uds:<pipe>" from-name="…">`, `origin.kind: "peer"` on a `user` record or a `queued_command` attachment) and the turn end (`stop_reason: "end_turn"`, `model: "<synthetic>"`) | core `cross-session.ts` (`createPromptTracker`, `isTurnEnd`, `mayConcernPrompts`), `transcript.ts` (`readActivityFromLines`, `readTranscriptActivity`, `SessionActivity.promptedBy`), read in daemon `scanner.ts`; desktop `shared/prompt-links.ts` and `shared/session-finished.ts` `waitsOn`. The measurement: `docs/design.md` "Cross-session messages" |
| Subagent files (`<sessionId>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json`) | core `paths.ts` `subagentsDirOf`, `subagent.ts` (`subagentIdFromFile`, `subagentMetaFile`), read in daemon `scanner.ts` `readSubagents` |
| The registry `entrypoint` values (`claude-vscode`, `cli`, `sdk-cli`) | desktop `shared/entrypoint.ts`, `main/focus-window.ts` (jump), `main/seen-elsewhere.ts` (only extension sessions count as seen by their tab) and `shared/request-source.ts` (the source label and the host word) |
| Hook payloads (`permission_mode` included) | daemon `hook-server.ts`, core `decision.ts` `parsePermissionRequest`. The measured shapes: `packages/core/fixtures/hook-payloads.json`, `spikes/m2-permission/RESULTS.md` |
| The hook response (`hookSpecificOutput`, `updatedPermissions`) | core `decision-response.ts` `buildHookResponse` |
| The hook configuration in `settings.json` | desktop `main/claude-integration.ts`; the list of hooks in core `hook-contract.ts` |
| Notification types and their roughly 6 s delay after the permission request | daemon `session-store.ts` `WAITING_TYPES`, `LATE_PROMPT_WINDOW_MS` |
| VS Code's window title: it contains the active tab's title (`${activeEditorShort}` in `window.title`), cut after 24 characters with `…`, and every VS Code window belongs to one process | desktop `main/seen-elsewhere.ts` (`showsTabTitle`, `sessionInFront`), read through `main/focus-window.ts` `readForegroundTitle`. The measurement: `docs/design.md` "The window title and the tab title" |
| The tab URI (`vscode://anthropic.claude-code/open?session=`) and `entrypoint === 'claude-vscode'` | desktop `main/focus-window.ts` `tabFocusUri`; the entrypoint constant is `shared/entrypoint.ts` `VSCODE_ENTRYPOINT` |
| Tool names and `tool_input` fields | core `tool-names.ts`, `decision.ts`, `tool-detail.ts`; renderer `edit-preview.ts`, `tool-details.ts`, `git-explain.ts` (Bash's `command`) |

## Environment notes

- **The renderer root is a real path.** On a drive mapped with `subst`, Vite resolves the HTML entry to the real path but keeps the root on the mapped one, and the build fails. So `apps/desktop/electron.vite.config.ts` resolves the renderer root (`RENDERER_ROOT`) and its entry pages with `realpathSync.native`. The comment there has the details.
- **`@types/node` follows Electron's Node, not yours.** The app runs on the Node.js inside Electron (Node 24 for Electron 45), so the `@types/node` major version matches that. It is declared only in the root `package.json`.
- **Generous timeouts for slow machines.** Starting processes can be slow on some Windows machines (a single PowerShell snapshot has taken about 6 s). The live Windows tests in `apps/desktop/src/main/focus-window.test.ts` have long timeouts for that reason, and the PowerShell fallback probe gives up only after `POWERSHELL_SNAPSHOT_TIMEOUT_MS` (30 s, in core `liveness.ts`).
