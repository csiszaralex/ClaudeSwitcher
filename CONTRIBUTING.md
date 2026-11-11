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
- `pnpm --filter @claudeswitcher/desktop dist` builds the Windows installer into `apps/desktop/release/` (NSIS, configured in `apps/desktop/electron-builder.yml` and `apps/desktop/resources/installer.nsh`).

### One instance at a time, and the hand-over

Only one ClaudeSwitcher runs at a time, installed or started from the repo: the daemon listens on a fixed port (`DAEMON_PORT`, 47821, in `apps/desktop/src/main/daemon-port.ts`), and the installed hooks point there. The rules live in `apps/desktop/src/main/index.ts` (`handOverOrQuit`, `runHelper`) and `apps/desktop/src/main/instance.ts` (`sameBuild`, `instanceAction`):

- The same build started again quits silently, and the running one shows its list.
- A different build (for example `start` while the installed app runs; `dev` and `start` count as different builds too) asks "Már fut egy ClaudeSwitcher (…). Bezárjam, és ez induljon?" ("ClaudeSwitcher is already running. Close it and start this one?"). On "Bezárás és indítás" it starts a `--quit` helper of itself, the running app quits through its normal quit sequence (its daemon releases the held requests), and the new one takes over within `HANDOVER_TIMEOUT_MS`.
- The running app writes `instance.json` to `userData` (`instance-file.ts`), so another build knows which build holds the lock.

The installer and the uninstaller use the same helper modes, `--quit` and `--uninstall`, with the exit codes in `LAUNCH_EXIT_CODE`. They never kill a process.

### Shared data

The installed app and every repo build use the same `userData` directory, `%APPDATA%\@claudeswitcher\desktop` (`apps/desktop/src/main/user-data.ts` `userDataDir`). It holds `config.json` (the settings and which of them the user confirmed), `daemon-token` and `instance.json`. Because the token is shared, hooks installed by one build keep working with the others. Start at login works only in the installed app: in a repo build the login item would register `electron.exe` (`autostart.ts`).

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

Session discovery runs alongside: every `POLL_INTERVAL_MS`, and after every `Stop`, `StopFailure` and `SessionEnd`, `daemon.ts` `refresh` calls `scanner.ts` `scanSessions`, which reads the session registry, the IDE lock files and the transcript tails.

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

For a change that should only touch comments (a translation, for example), `pnpm check:comment-only -- <base>` (`scripts/check-comment-only-diff.mjs`) compares the token streams of every changed source file and fails on any change outside comments, test titles and the strings listed in an optional `--allow` file. The usage is at the top of the script.

### Code

- **No synchronous child processes** (`execSync`, `execFileSync`, `spawnSync`) outside tests. They stop the Electron main thread, and with it the daemon and every session's hooks. ESLint enforces this.
- **The renderer imports values only from `@claudeswitcher/core/browser`.** From `@claudeswitcher/core` and `@claudeswitcher/daemon` it may import types only; ESLint enforces this, and the renderer's tsconfig has no Node types. A core module may be exported from `/browser` only if it imports no `node:` module.
- **One fact in one place.** Every value, rule or constant lives in exactly one module, and everything else imports it. The shared homes are listed in the [module index](#module-index). Before adding a constant, look for its existing home.
- **GUI texts are Hungarian; everything else is English** (identifiers, comments, logs, non-GUI errors, docs).
- **Invented data in tests.** No real transcript content or local data (session ids, folder names, user names, tokens) in fixtures or tests. Use invented, well-formed values, such as a fresh UUID, `p:\proj\alpha` or `pidDomain: 'win32:user'`, and keep the measured shape. The measured hook payloads live in `packages/core/fixtures/hook-payloads.json`; tests load them through `@claudeswitcher/core/testing` (`hookPayload`, `parsedPayload`).

### Commits

[Conventional Commits](https://www.conventionalcommits.org/) with exactly one scope, in English, one independent change per commit. The scopes in use are `core`, `daemon`, `desktop`, `repo` and `deps`. For example: `fix(daemon): release held requests before the server closes`.

## Module index

The shared modules, each the one home of its facts. Core modules marked "/browser" are also exported by `@claudeswitcher/core/browser`.

**Core (`packages/core/src/`):**

- `hook-contract.ts` (/browser): the installed hooks (`HOOK_CONTRACT`), their routes and timeouts, the release time computed from the 600 s permission timeout (`PERMISSION_RELEASE_AFTER_MS`), the retired hooks (`LEGACY_HOOK_CONTRACT`), and the `lifecycle/*` kinds (`isLifecycleKind`, `lifecyclePath`).
- `timings.ts`: the timings several modules use (`POLL_INTERVAL_MS`, `PROBE_TTL_MS`). It imports nothing from Node, but `/browser` does not export it.
- `protocol.ts` (/browser): the contract between the daemon and the renderer: the protocol version (`DAEMON_PROTOCOL`) and the daemon's address (`DAEMON_HOST`, `DAEMON_WS_PATH`, `DAEMON_WS_TOKEN_PARAM`, `daemonWsUrl`). The renderer CSP (`apps/desktop/src/csp/renderer-csp.ts`) keeps the host as its own literal, and its test ties it to `DAEMON_HOST`.
- `guards.ts` (/browser): input guards (`isRecord`, `nonEmptyString` and others), and flattening text to one line and truncating it (`flatText`, `truncate`).
- `tool-names.ts` (/browser): the tool name sets (edit tools, command tools). `decision.ts` picks each tool's required field from them (`requiredField`).
- `decision.ts` (/browser): parsing and classifying a permission request (`parsePermissionRequest`) and the decision kinds (`DecisionKind`).
- `paths.ts`: the locations under Claude Code's configuration directory (`resolveClaudeDir`, `sessionsDir`, `ideDir`, `userSettingsPath`, `projectsDir`, `subagentsDirOf`).
- `testing.ts` (the `@claudeswitcher/core/testing` entry, tests only): the fixture loader (`hookPayload`, `parsedPayload`), `tempDir`, the fake process probe (`fakeProbe`) and a fake session record writer (`writeSessionRecord`).

**Daemon (`packages/daemon/src/`):**

- `token.ts`: the token format (`createToken`, `isToken`); the desktop app's `token.ts` uses it.

**Desktop (`apps/desktop/src/`):**

- `main/daemon-port.ts`: the daemon's fixed port (`DAEMON_PORT`). A module without imports, because the build config reads it too.
- `main/instance.ts`: the helper flags (`HELPER_FLAG`) and exit codes (`LAUNCH_EXIT_CODE`) that `resources/installer.nsh` repeats as literals; `instance.test.ts` checks that the two agree.
- `shared/settings.ts`: the one list of user settings (`SETTINGS`, `DEFAULT_SETTINGS`, `DEFAULT_HOTKEY`).
- `shared/overlay-channels.ts`, `shared/setup-channels.ts`: the IPC channel names and reply types of the two windows.

## Claude Code coupling points

The app reads several undocumented Claude Code internals. If Claude Code changes, start here:

| Internal | Where it is read |
|---|---|
| `~/.claude/sessions/<pid>.json` (the live session registry) | core `session-registry.ts` `parseSessionRecord`, read in daemon `scanner.ts`. A record that lacks a required field is dropped silently. |
| `procStart` (the process creation FILETIME as a decimal string) and process liveness | core `liveness.ts` (`ProcessProbe.isAlive`, `parsePowerShellSnapshot`), desktop `main/process-probe.ts` |
| `~/.claude/ide/<port>.lock` and the VS Code process image names | core `session-registry.ts` `parseIdeLock`, `liveness.ts` `VSCODE_IMAGE_NAMES` |
| The transcript, `projects/<encoded cwd>/<sessionId>.jsonl`, and the shape of its blocks | core `paths.ts` `projectsDir`, `transcript.ts` (`findTranscriptPath`, `readActivityFromLines`), `tool-detail.ts` |
| Subagent files (`<sessionId>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json`) | core `paths.ts` `subagentsDirOf`, `subagent.ts` (`subagentIdFromFile`, `subagentMetaFile`), read in daemon `scanner.ts` `readSubagents` |
| Hook payloads | daemon `hook-server.ts`, core `decision.ts` `parsePermissionRequest`. The measured shapes: `packages/core/fixtures/hook-payloads.json`, `spikes/m2-permission/RESULTS.md` |
| The hook response (`hookSpecificOutput`, `updatedPermissions`) | core `decision-response.ts` `buildHookResponse` |
| The hook configuration in `settings.json` | desktop `main/claude-integration.ts`; the list of hooks in core `hook-contract.ts` |
| Notification types and their roughly 6 s delay after the permission request | daemon `session-store.ts` `WAITING_TYPES`, `LATE_PROMPT_WINDOW_MS` |
| The tab URI (`vscode://anthropic.claude-code/open?session=`) and `entrypoint === 'claude-vscode'` | desktop `main/focus-window.ts` `tabFocusUri`, `VSCODE_ENTRYPOINT` |
| Tool names and `tool_input` fields | core `tool-names.ts`, `decision.ts`, `tool-detail.ts`; renderer `edit-preview.ts`, `tool-details.ts` |

## Environment notes

- **The renderer root is a real path.** On a drive mapped with `subst`, Vite resolves the HTML entry to the real path but keeps the root on the mapped one, and the build fails. So `apps/desktop/electron.vite.config.ts` resolves the renderer root (`RENDERER_ROOT`) and its entry pages with `realpathSync.native`. The comment there has the details.
- **`@types/node` follows Electron's Node, not yours.** The app runs on the Node.js inside Electron (Node 24 for Electron 45), so the `@types/node` major version matches that. It is declared only in the root `package.json`.
- **Generous timeouts for slow machines.** Starting processes can be slow on some Windows machines (a single PowerShell snapshot has taken about 6 s). The live Windows tests in `apps/desktop/src/main/focus-window.test.ts` have long timeouts for that reason, and the PowerShell fallback probe gives up only after `POWERSHELL_SNAPSHOT_TIMEOUT_MS` (30 s, in core `liveness.ts`).
