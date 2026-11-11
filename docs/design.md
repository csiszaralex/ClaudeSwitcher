# ClaudeSwitcher: design

**Date:** 2026-09-04 · **Revision:** 2026-10-30
**Status:** the monitor, the approve and the tab focus milestones are done and in daily use (§11). The
fixes from the full repository review of 2026-10-25 are in as well.
**Platform:** Windows 11, VS Code + the Claude Code extension (v2.1.259)

> **The 2026-10-30 revision.** Aligning the spec with the code after the review: the rate limit
> feature retired (§3.5), the native No/Esc measured and the two hooks that end in an error (§3.4),
> the real split of the core (§4, §7), the poll instead of the file watcher (§7), the keys (§4), the
> dropped registry record (§8), the signals of a native deny (§9), the Electron hardening (§7) and
> the state of the milestones (§11).

> **The gist of the 2026-10-08 revision.** The permission spike (§10) showed that in the VS Code
> extension the native prompt **is visible while the hook is held too**, and the first decision
> wins, wherever it comes from. That removes the lease model, the presence policy, our own rule
> generator and our own settings file writer. Added: answering questions, rejecting a plan with
> feedback, and an editable preview of the rule. The limit display does not work in the extension
> (§3.5). Details: `spikes/m2-permission/RESULTS.md`.

## 1. Problem

The machine regularly runs 8 to 10 Claude Code sessions in parallel, all in the VS Code extension,
often several in the same window. There is no single view of which one waits for an approval, which
one works and which one is done. Getting there means hunting for the window by hand, and there is no
view of the session and weekly limits.

The official `claude agents` (Agent View) does not solve this: as documented, it shows **only the
sessions sent to the background (`--bg`)**, not the VS Code extension sessions. So it leaves out
exactly the relevant set.

## 2. Goals

1. See every running Claude Code session and its state in one place. **✅ monitor milestone**
2. Jump to the right VS Code **window and tab** with one key press. **window ✅ monitor
   milestone, tab ✅ tab focus milestone (2026-10-21, without an extension of our own)**
3. Approve inside the app, without switching windows, and not only once but also allow at project
   or machine level. **Approve milestone; the spike says it is feasible, except approving a plan**
   (§10). Extended at the user's request: answering a question and rejecting a plan with feedback
   too.
4. See the state of the session (5 hour) and weekly limits, and when they reset. **❌ not
   achievable in the VS Code extension** (§3.5); the user let it go, and the feature was removed on
   2026-10-27.

### Non-goals

- It does not replace Remote Control, and does not use it as a transport.
- It does not start, stop or control sessions (it sends no prompt).
- Not cross-platform: Windows only.

## 3. Measured facts: the raw material

Everything below was checked on the machine, with Claude Code v2.1.259.

### 3.1 The live session registry (undocumented)

`~/.claude/sessions/<pid>.json`: one file per session, real content:

```json
{
  "pid": 21548,
  "sessionId": "5f8f1fc5-b7f1-4a9a-a80c-c83aff747732",
  "cwd": "p:\\proj\\alpha",
  "startedAt": 1788447404737,
  "procStart": "134329210033019891",
  "version": "2.1.259",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle", "artifact_yield"],
  "kind": "interactive",
  "entrypoint": "claude-vscode",
  "pidDomain": "win32:user",
  "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-2c65229760e23d2e33060f185c17dad9",
  "name": "alpha-58",
  "nameSource": "derived",
  "nameSince": 1788447404738,
  "bridgeSessionId": "session_01Qx7RmZ4kT9bWcN2vHs8LpD"
}
```

Next to it, a `<pid>.<hash>` file: `{"peerToken":"…","procStartFt":"…","pidDomain":"…"}`.

`procStart` is the Windows process creation FILETIME. **The pid alone is not enough to check
liveness:** the `~/.claude/ide/` folder currently holds 20 lock files, and pid 8108 appears with
two different workspaces (pid reuse). Liveness = the pid exists **and** the process creation time
matches.

**From Claude Code 2.1.296** (measured, 2026-10-20) the file carries the state too: `status`
(`idle` | `busy` | `waiting`), `waitingFor` (for example `"permission prompt"`) and
`statusUpdatedAt` (ms). The app uses it for display only: after a restart, a session whose request
arrived before the app started shows as waiting this way (with no decision: only VS Code can make
that one); `busy` counts as working.

### 3.2 Mapping to VS Code windows (undocumented)

`~/.claude/ide/<port>.lock`:

```json
{
  "pid": 8108,
  "workspaceFolders": ["p:\\08_Apps\\ClaudeSwitcher"],
  "ideName": "Visual Studio Code",
  "transport": "ws",
  "runningInWindows": true,
  "authToken": "9602c76f-…"
}
```

The `pid` is the VS Code window's process (checked: 8108 → the window whose `MainWindowTitle` is
"ClaudeSwitcher – …"). Pairing a session with a window: `session.cwd` ⊂ `lock.workspaceFolders`.

### 3.3 Transcript

`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, appended live. Record types in the real
file: `queue-operation`, `user`, `attachment`, `file-history-snapshot`, `ai-title`, `atis-latch`,
`assistant`, and more. Little of it is needed; **an unknown type is skipped, it must never throw.**

### 3.4 Hooks: measured in the VS Code extension

The original text worked from the documentation. What follows is the **measured** behaviour
(`entrypoint: claude-vscode`, from a raw payload log, during the monitor milestone's acceptance
test and the permission spike).

- **`PermissionRequest`**: runs both as an HTTP hook and as a command hook, in every measured case:
  Bash, PowerShell, Write, Edit, WebFetch, an MCP tool, **AskUserQuestion**, **ExitPlanMode**.
  Input: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`,
  `tool_name`, `tool_input`, `permission_suggestions`, for MCP `mcp_server` (`name`, `source`),
  **for a subagent `agent_id` and `agent_type`**. There is no `tool_use_id` in it.
  Output (the original spec was wrong here), the `decision` object:
  ```json
  {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
     "decision": {"behavior": "allow",
                  "updatedInput": {…},
                  "updatedPermissions": [{"type": "addRules", "rules": […],
                                          "behavior": "allow", "destination": "…"}]}}}
  ```
  Deny: `{"behavior": "deny", "message": "…"}`; the model receives the `message`.
  An empty 200 = no decision.
- **The native prompt does not wait for the hook.** It appears in the VS Code panel at once, while
  the hook is held too; the phone (Remote Control) gets it as well. **The first decision wins**: a
  click in VS Code, the phone, or the hook's `allow`/`deny`. In the last case the panel's prompt
  disappears and the tool runs in the same second. After the hook is released (an empty 200) the
  prompt stays and can be answered without a time limit (measured 2.5 minutes later).
- **On a native allow Claude Code does not close the held HTTP request**, so the daemon cannot
  learn from the connection that it is decided. The signal is `PostToolUse` (with the same
  `tool_use_id`), or `PostToolUseFailure` if the started tool ended with an error. If the turn
  ends in the meantime, the session's `Stop` / `SessionEnd`, for a subagent the `SubagentStop`,
  closes the row (§7 `DecisionBroker`).
- **A native No or Esc in VS Code** (measured, 2026-10-25): **no hook arrives at all**, no `Stop`,
  no `PostToolUse`, no `Notification`. Instead Claude Code **aborts the held `PermissionRequest`
  connection**. The broker closes the row on the abort, and if the session has no other pending
  request, the daemon clears the waiting state caused by `Notification` in the same change
  (`DecisionBroker` `DecisionChange.abortedSessionId`, `SessionStore` `applyPending`). For a native
  answer within about 6 s no `Notification` arrives either.
- **`PostToolUseFailure` and `StopFailure`** (per the hook documentation, 2026-10-25; the fixtures
  were made from the documentation, they were not recorded live). The first one goes to a tool that
  started but ended with an error, instead of `PostToolUse`; the second one to a turn that ends with
  an API error (rate limit, overloaded), instead of `Stop`. Both go to the route of their
  successful pair (`hook-contract.ts` `HOOK_CONTRACT`).
- **`Notification`**: a `permission_prompt` comes only if the prompt has been pending for **about
  6 s**; requests answered quickly do not signal. The text is in the **`message`** field ("Claude
  needs your permission to use Bash"), not in `notification_text`. There is no `agent_id` in it: a
  subagent's request arrives with the parent's `session_id`.
- **`Stop`**: reliable, and brings `last_assistant_message` too. **`SessionEnd`**: arrives.
- **`SessionStart`**: **never arrives as an HTTP hook, only as a command hook.**
- **`PreToolUse` / `PostToolUse` / `SubagentStart` / `SubagentStop`**: arrive over HTTP.
- **Subagent transcripts** are in a separate file: `<session>/subagents/agent-<id>.jsonl`
  (`isSidechain: true`, `agentId`, with the **parent's** `sessionId`); they are not in the main
  transcript.

HTTP hook configuration (unchanged):

```json
{"type": "http", "url": "http://127.0.0.1:<port>/hooks/permission-request",
 "timeout": 600, "headers": {"Authorization": "Bearer $CLAUDESWITCHER_TOKEN"},
 "allowedEnvVars": ["CLAUDESWITCHER_TOKEN"]}
```

The default timeout is 600 s. Since the native prompt stays after the timeout too, the timeout
limits only how long the app can decide, not how long the user can.

### 3.5 Limits (documented, retired)

> **Decision (2026-10-27): the rate limit feature was removed** (`ca9f528`). The reason: the VS Code
> extension does not run the statusLine (below, measured), yet the install wrote a statusLine into
> the global `~/.claude/settings.json`, which moreover pointed at the repo's build output with an
> absolute path. It wrote into the user's global configuration for a feature that does not work on
> the main platform. Removed: `packages/statusline`, the daemon's `/statusline` route and the
> renderer's limit display. Install and uninstall recognise and remove the old statusLine marked
> with `--claudeswitcher` and `env.CLAUDESWITCHER_PORT` (`claude-integration.ts`
> `withoutOurStatusLine`), and leave a foreign statusLine alone. The measurement below is the basis
> of the decision, so it stays.

The only source is the statusLine script's stdin JSON:

```json
"rate_limits": {
  "five_hour":   {"used_percentage": 23.5, "resets_at": 1738425600},
  "seven_day":   {"used_percentage": 41.2, "resets_at": 1738857600},
  "spend_limit": {"used_percentage": 62.8, "resets_at": 1740787200}}
```

Only for Claude.ai Pro/Max subscribers, and only after the session's first API response. It is
account-level data, so a single running session is enough as a source. Each window disappears as
soon as its `resets_at` has passed.

**The cost:** a statusLine has to be configured (there is none now). With a custom statusLine
Claude Code hides the footer's key hints (`esc to interrupt`, `? for shortcuts`), so the
statusLine has to show something useful too, not just post silently.

**Measured (monitor milestone acceptance test): the VS Code extension does not run the statusLine
command.** A `claude-vscode` session received the installed `env` variables, yet not a single
report arrived; the script, called directly, reached the daemon without an error. There is no
other local source (`~/.claude` and the transcripts of six projects were searched). So the limit
display could have received data only from terminal sessions. **Goal 4 cannot be met on this
platform.**

### 3.6 Writing permission rules (documented)

The TUI's "Yes, and don't ask again" writes into the `.claude/settings.local.json` of the **git
repo root**. Machine level: `~/.claude/settings.json` → `permissions.allow`. Syntax:
`Bash(pnpm test *)`, `Read(./.env)`, `WebFetch(domain:example.com)`. Evaluation: deny → ask →
allow, the first match decides. **A file edit approval (`Edit`/`Write`) cannot be saved to a
file**: in the TUI too it lasts only until the end of the session.

**Measured (permission spike): we do not have to invent the rule, and we do not have to write
it.**
- The `permission_suggestions` field of `PermissionRequest` brings Claude Code's own suggestion:
  Bash → `Bash(echo x *)`, WebFetch → `WebFetch(domain:…)`, MCP → the tool's name, all with the
  `localSettings` destination; Write/Edit → `setMode: acceptEdits` for the session.
- If the hook returns `allow` with `updatedPermissions`, **Claude Code writes the rule itself**:
  `localSettings` → `.claude/settings.local.json`, `userSettings` → `~/.claude/settings.json`
  (both measured).
- **It also accepts any rule we give, not only its own suggestion.** This is what makes the
  editable preview possible.
- Open: a suggested rule written for a Bash command with a redirect (`>`) did not prevent the next
  prompt in the same session. This is Claude Code's matching logic, and it applies to the native
  "don't ask again" button the same way.

### 3.7 Remote Control

On the machine it is switched on automatically for every session. 8 of the 9 live sessions carry
a `bridgeSessionId` (`session_01…` format).

~~**Critical consequence:** if the daemon takes the `PermissionRequest`, the native prompt is not
created, so the phone does not get it either.~~ **Measured (permission spike): not so.** While the
hook is held, the prompt appears on the phone too, and approved from there the tool runs. The §6
presence policy was therefore removed.

### 3.8 The VS Code extension's commands

The official extension (`anthropic.claude-code-2.1.259-win32-x64`) has, among others:
`claude-vscode.editor.openLast`, `claude-vscode.editor.open`, `claude-vscode.focus`,
`claude-vscode.markSessionUnread`, `claude-vscode.renameSessionTab`. **They cannot be called from
outside.** ~~That is why our own companion extension is needed, which calls them from its own
window.~~ Not needed: the tab focus comes from the extension's own URI handler (§7, "Tab focus"),
and the companion extension was not built (§11, tab focus milestone).

## 4. Architecture

```
claudeswitcher/                    pnpm workspace + Nx
├─ packages/core/          session discovery, transcript parsing, decision model, hook contract
│                          with two entry points: `index` (Node) and `/browser` (Node-free)
├─ packages/daemon/        hook HTTP endpoint, WS hub, poll, DecisionBroker
├─ apps/desktop/           Electron: tray, global hotkey, overlay
```

**The core is not IO-free.** `liveness.ts` (the PowerShell fallback probe), `transcript.ts`,
`settings-writer.ts` and `paths.ts` use `node:` modules. So it has two entry points: the main
`index` exports everything, `/browser` only the modules without a `node:` import (`browser.ts`:
the decision model, the guards, the hook contract, the protocol, the rule text, subagent, tool
details, tool names). The renderer may import only `/browser` as a value; an ESLint rule enforces
this (`eslint.config.mjs`, `@typescript-eslint/no-restricted-imports`).

(The originally planned `apps/vscode-ext` companion extension was not built, and it is not needed:
the tab focus comes from Claude Code's own URI, see §7 and §11.)

**Stack:** 100% TypeScript. Electron (not Tauri: the memory argument does not hold with 64 GB, and
Tauri would mix Rust into an otherwise pure TS repo). The `SetForegroundWindow` /
`ShowWindowAsync` call goes through `koffi` (prebuilt FFI, no node-gyp). Nx, because it is the
default of the owner's other repositories: three packages do not need it, but the entry cost is one
config file.

Versions (2026-10-30, after the dependency upgrade that followed the review): Electron 45 (Node
24), electron-vite 6, Vite 8, vitest 5, `@vitejs/plugin-react` 6, React 19, TypeScript 6, ESLint 10,
Nx 24, koffi 3, pnpm 12. The exact versions are pinned by the `package.json` files and
`pnpm-lock.yaml`. The main process is an ES module, the preload is CommonJS (a sandboxed preload
cannot be an ES module), and the workspace packages are built into the main process bundle:
`apps/desktop/electron.vite.config.ts`.

**The daemon runs in the Electron main process**, not as a separate process: the WS hub has one
owner, and the lifecycle is simpler. The module boundary is there, though, in case it has to be
moved out later.

**Form factor:** a tray icon + a global hotkey overlay. Normally invisible; the tray badge shows
the number of waiting sessions, and the hotkey brings up a compact list.

**Keys** (`App.tsx` `onKey`, `decision-actions.ts` `SHORTCUTS`; since changed: the shortcut table
is now `ACTION_BUTTONS`, read by `shortcutFor`):
- the arrows move the selection, Esc hides the overlay;
- Enter jumps to the selected session's window (and tab), except on a focused button, `<summary>`
  or link, where it belongs to the element. Tab jumps too, but only without an open decision
  panel: on the panel it moves between the buttons;
- approving works with the panel's letters: for a `tool` request A = allow, D = deny, P = project
  level, G = machine level; for an `edit` request A, D and S = the session's further edits. A
  question and a plan have no letter. For an unreadable request only D remains;
- in a text field the typing belongs to the field. The letters do not fire on a key repeat, on a
  freshly shown panel, or for a short time after typing (`key-guard.ts`).

## 5. Data flow

Three inputs feed one state machine:

1. **Discovery**: polling `sessions/*.json` + `ide/*.lock` (§7, `POLL_INTERVAL_MS`), liveness by
   pid + `procStart`, pairing by `cwd` ⊂ `workspaceFolders`.
2. **Status**: tailing the transcript `.jsonl` → what it is doing right now.
3. **Events**: the hooks: `PermissionRequest` (holds a decision), `PostToolUse` /
   `PostToolUseFailure` / `PreToolUse` / `SubagentStop` (detecting a native decision),
   `Notification` (signals), `Stop` / `StopFailure` / `SessionEnd` (lifecycle). The full list:
   `hook-contract.ts` `HOOK_CONTRACT`.
4. ~~**Limits**: the statusLine `rate_limits`~~: retired (§3.5).

### The lifecycle of a decision (approve milestone, after the spike)

The principle: **the app is a second place to decide; it does not take away the first one.** The
native prompt is there the whole time, in VS Code and on the phone (§3.4).

```
PermissionRequest ─→ PendingDecision, the HTTP response suspended
                     ├─→ overlay: a row appears, the tray badge grows
                     └─→ meanwhile the native prompt is already visible in VS Code and on the phone

   THE FIRST DECISION WINS, from three sources:
   ├─ the app (overlay)  → HTTP response: allow / deny (+ updatedInput / updatedPermissions)
   ├─ VS Code / phone    → the daemon learns it from PostToolUse/PostToolUseFailure (allow), from
   │                       the aborted connection (native No/Esc, §3.4), or from
   │                       Stop/SessionEnd/SubagentStop (the end of the turn);
   │                       the pending request gets an empty 200, which Claude Code drops
   └─ release            → an empty 200 at 590 s (the hook timeout is 600); the row switches
                           to the "decide in VS Code" state, the prompt stays
```

**The overlay offers different things by the kind of request:**

| `tool_name` | The overlay shows | Buttons | Answer to the hook |
|---|---|---|---|
| Bash, PowerShell, WebFetch, MCP, … | the tool, the input, who asks (session or subagent) | Allow · Deny (with a reason) · Project level · Machine level | `allow` / `deny`+`message` / `allow`+`updatedPermissions` |
| Write, Edit | the file, a diff summary | Allow · Deny · For this session automatically | `allow` / `deny` / `allow`+`setMode acceptEdits session` |
| AskUserQuestion | the questions and the options | option choice (several for multi-select), free text → Answer | `allow`+`updatedInput.answers` (key: the question's text, value: the option label; several labels joined with `", "`; free text verbatim) |
| ExitPlanMode | the plan's text | Reject with feedback · **"Jóváhagyás a VSCode-ban"** (approve in VS Code: jumps there) | `deny`+`message`; it cannot be approved from the hook (§10) |

**Project and machine level rule.** Claude Code's suggestion (`permission_suggestions`) **appears
editable**; the user can rewrite it (narrow it), and Claude Code itself writes the approved
version (`localSettings` / `userSettings`). The app writes no settings file. The machine level
option asks for a separate confirmation, because it affects every session.

**A late click.** If the decision has already been made (from any source), the overlay's row
disappears; a click that arrives meanwhile is a no-op. After a release the row stays, but only
with the "Ugrás a VSCode-ba" (jump to VS Code) button.

## 6. ~~Presence policy~~: removed

In the original design holding would have taken the native prompt away from the phone, so the
daemon would have given up the decision on a locked machine, when idle, or with the window in the
foreground. The spike showed that **holding takes nothing away**: VS Code and the phone get the
prompt just the same, and it can be decided from there too. There is nothing to protect.

## 7. Components

### `packages/core`, the testable core

Not IO-free; the Node-free part is available through the `/browser` entry point (§4).

- **`SessionRegistry`**: parsing `sessions/*.json` and `ide/*.lock`, liveness, pairing. Its input
  is the already read file content + a `ProcessProbe` interface, so it can be tested without real
  files.
- **`TranscriptReader`**: the last N lines → `SessionActivity` (the last assistant message, the
  running tool, a timestamp). Skipping an unknown record type is mandatory.
- ~~**`RuleBuilder`**~~: **removed**: Claude Code provides the rule (`permission_suggestions`).
- **`DecisionModel`** (new in the approve milestone): pure functions for the two ends of a
  decision:
  - *classification*: `PermissionRequest` → `{ kind: 'tool' | 'edit' | 'question' | 'plan', … }`
    (the table in §5), with the data to show (tool, input, questions, plan, the subagent that
    asks);
  - *answer*: the user's decision → the hook's response JSON (`allow`/`deny`, `updatedInput`,
    `updatedPermissions`). The format of the question answers and of the rule destinations lives
    here in one place, with table tests;
  - *rule preview*: `permission_suggestions` ⇄ editable text (`Bash(echo x *)`), with an error on
    an invalid edit, not a silent pass.
- **`SettingsWriter`**: stays for installing the hooks, as in the monitor milestone (atomic,
  queued, parse-safe). **The approve milestone does not use it to write rules**: Claude Code does
  that. Only `ENOENT` counts as a missing file; every other read error and a persistently empty
  read throws; before the rename it checks by `mtimeMs` and size that nobody else wrote the file in
  the meantime (since changed: it compares the content, not the mtime and the size,
  `settings-writer.ts` `writeTransformed`); before the first write it makes a
  `settings.json.claudeswitcher-backup` copy once. The desktop `config.ts` writes through it too.
- **Shared modules, one fact in one place:** `hook-contract.ts` (the installed hooks, their routes
  and timeouts, and the release time: `PERMISSION_RELEASE_AFTER_MS`, computed from the 600 s
  timeout), `timings.ts` (`POLL_INTERVAL_MS`, `PROBE_TTL_MS`), `guards.ts` (input guards),
  `tool-names.ts` (tool name sets), `protocol.ts` (`DAEMON_PROTOCOL`).

### `packages/daemon`

- **`HookServer`**: binds to loopback only, a bearer token in the header, compared in constant
  time (`token-compare.ts`). The route paths come from the core's `HOOK_CONTRACT`; the
  `PermissionRequest` gets a held response.
- **`DecisionBroker`** (approve milestone): the owner of the `PendingDecision`s: creating them, an
  idempotent resolve, the release at 590 s. **The system's only real concurrent state machine**,
  so it is a separate module with a separate test suite. There is no lease timer; it recognises a
  native decision by the `tool_use_id`: `PreToolUse` (which comes right before the
  `PermissionRequest`, with the same session/tool/input) provides the `tool_use_id`, and
  `PostToolUse` (or `PostToolUseFailure`) closes it with the same one. The pairing key includes
  the `agent_id` too (`callKey`). Native No/Esc: Claude Code aborts the held connection, and the
  broker closes on that (§3.4). The end of the turn: the session's `Stop` or `SessionEnd`, for a
  subagent's request the `SubagentStop` (with the same `agent_id`).
  **Not** the next `PreToolUse`: Claude Code can start tool calls in parallel within one session,
  and the `PreToolUse` of another call would close a still pending, legitimate request. What stays
  open this way is closed by the release at 590 s.
- ~~**`PresencePolicy`**~~: **removed** (§6).
- ~~**`Watchers`**: file watchers with a debounce.~~ There is no file watcher: the daemon re-reads
  the registry, the locks and the transcripts every `POLL_INTERVAL_MS` (3 s), and also right
  after every `Stop`/`StopFailure`/`SessionEnd` hook (`daemon.ts` `refresh`, only one runs at a
  time). After every successful scan a `tick` goes to the overlay.
- **`Hub`**: WS towards the overlay (there is no extension). It checks the token before the
  handshake (`verifyClient`), and every message carries the `protocol` version
  (`DAEMON_PROTOCOL`).

### `apps/desktop`

Electron main: tray + badge, global hotkey, a frameless always-on-top overlay, `koffi` for the
window focus. Renderer: the list, a status per session, and for the waiting ones the tool and its
input. Since the approve milestone a waiting row can be expanded: the buttons of the §5 table, an
option picker for the questions, the full text and a feedback field for the plan, an editable
preview for the rule. The keyboard control stays (arrows, Enter, Esc), and the overlay does not
close automatically after a decision if something else is waiting too. ~~Limit bars~~: retired
(§3.5).

**Hardening** (from the repository review): the overlay and the settings window cannot navigate
(`will-navigate` blocked), cannot open a new window (`setWindowOpenHandler` → `deny`), and reject
every permission request (`harden-window.ts` `hardenWindow`). Every IPC handler checks that the call
came from its own page (`ipc-sender.ts` `isRendererSender`): in production the overlay's handlers
reject the settings page too, and the other way round. The renderer CSP is built in one place
(`csp/renderer-csp.ts`): the WebSocket is narrowed to the exact daemon port (`DAEMON_PORT`,
47821), `object-src`, `base-uri` and `form-action` are `'none'`, and `'unsafe-inline'` is allowed
only on the dev server.

**An outdated install.** At start-up and after every install or uninstall the main process
compares the hooks in `settings.json` with `HOOK_CONTRACT` (`claude-integration.ts`
`hookInstallState`). If a hook is missing, the tray menu warns: "Integráció elavult, telepítsd
újra" (the integration is outdated, install it again). This only reads the file. (Since changed:
it also warns when `env.CLAUDESWITCHER_TOKEN` is not the daemon's token, since every hook would
then get a 401; the notice names the reason.)

### Tab focus (tab focus milestone): without an extension of our own

The Claude Code extension's URI handler (2.1.304, read from its code):
`vscode://anthropic.claude-code/open?session=<sessionId>` → `claude-vscode.primaryEditor.open`
→ if the session has a tab, `reveal()`; if the sidebar holds it, it shows it there; otherwise it
opens a **new** tab. Measured (2026-10-21): the URI goes to the **topmost, most recently active**
VS Code window. If that is the session's window, it switches to the right tab (even when VS Code
is not in the foreground); if it is another one, a new tab opens there.

So the app (`focus-window.ts`, `tabFocusUri`) first brings up the window (the monitor milestone's
path), and sends the URI (`shell.openExternal`, after a wait of about 200 ms) only if the window
came up verified through the `pid` path, or through the `code <workspaceFolder>` path; the `code`
call with the `cwd` (possibly a new window) and a failed focus are excluded. Since 2026-10-25 the
CLI runs without `-r`, and for a session known not to be `claude-vscode` it does not run at all
(the reasons: `focus-window.ts` `codeCliCommand` and `focusWith`). Only for an
`entrypoint: claude-vscode` session, only for a UUID, and only with the "Ugrás a pontos
Claude-tabra" tray checkbox on. If any condition is missing, the behaviour is the monitor
milestone's: the window only.

There is **no** decision surface in the VS Code window (decision of 2026-10-20): the native prompt
is visible there anyway, and a second surface would only be a duplicate and a source of errors.

## 8. Error handling

The guiding principle: **an error of the app must never block a session.**

- The daemon is not running / the port is taken / a crash → connection refused → the native flow,
  unchanged. **Measured** (§10): it works exactly as without the hook.
- An Electron restart or crash with suspended decisions → the connections die → **measured:** the
  native prompt stays and can be answered, and Claude Code does not take it as a deny. So an error
  of the app never denies a command.
- **The app may not decide blindly on a question or a plan**: for `AskUserQuestion` it gives
  `allow` only with the options the user chose, and for `ExitPlanMode` it never gives `allow`. A
  wrong classification thus means at most a needless row, not a question let through without an
  answer.
- **An unknown `sessions/*.json` schema after a version change** → if a required field (`pid`,
  `sessionId`, `cwd`, `startedAt`) is missing or has the wrong type, `parseSessionRecord` returns
  `null`, and the scanner **drops the record**, without logging: the session does not appear in the
  list. There is no unknown status (`SessionStatus` is only `waiting`, `working`, `idle`). Approving
  still works, because it rests on the hook's `session_id`, not on the registry: the held request
  shows as a row of its own (`rows.ts`, orphan rows). A deliberate layering: the failure of the
  fragile discovery does not take the stable part with it.
- A settings file that does not parse → we do not write, we show an error; the Allow still goes
  through.
- Single instance: the second instance only brings up the overlay. (Since changed: this holds for
  the same build; a different build offers to close the running one and take over,
  `instance.ts` `instanceAction`, `index.ts` `handOverOrQuit`.)

## 9. Testing

- **`core`**: unit tests, fixture based, with anonymised snapshots of the real `sessions/`, `ide/`
  and transcript files (including the 20 orphaned lock files and the pid collision). The
  `DecisionModel` with a table test, with **the real payloads recorded in the spike** as fixtures
  (Bash, Write, Edit, WebFetch, MCP, AskUserQuestion, ExitPlanMode, subagent).
- **`DecisionBroker`**: concurrency: an app and a native decision at the same time; a native
  decision from `PostToolUse` and from `PostToolUseFailure`; the end of the turn from
  `Stop`/`SessionEnd`/`SubagentStop`; the hook client aborting (native No/Esc, §3.4); the release
  at 590 s; a click after the release; parallel calls with the same input in the same session, the
  main agent and a subagent paired separately. The next `PreToolUse` does **not** close a row (§7).
- **`HookServer`**: a contract test against the **measured** hook JSON schemas (not the documented
  ones: in the monitor milestone relying on the documentation led to a wrong field name).
- **Acceptance test**: modelled on the spike's scenario, run live.

## 10. Spike: measured (2026-10-08)

In a throwaway test project, with project-level hooks, without touching the running sessions or
the global configuration (the one exception is K5: a harmless test rule in the global file,
removed afterwards, the file bit-identical to the backup). The tool and the full results:
`spikes/m2-permission/` (`RESULTS.md`).

| Original question | Result |
|---|---|
| 1. What does `PermissionRequest` run for? | Bash, PowerShell, Write, Edit, WebFetch, MCP, AskUserQuestion, ExitPlanMode: all of them. Folder trust did not come up |
| 2. After a release, a native prompt: does it wait? | The prompt is visible **from the start**; after a release it stays answerable |
| 3. Does it take the prompt away from Remote Control? | **No** |
| 4. Timeout > 600? | Not measured: without the lease model it is not needed |
| 5. claude.ai session URL | Not measured: a question for the tab focus milestone / a QR code |

**For the new needs** (the user's decision: questions and plans should be answerable from the app
too; a machine level rule with an editable preview): answering a question ✅, rejecting a plan with
feedback ✅, **approving a plan ❌** (a plain `allow`, `allow`+`setMode`, and a `PreToolUse`
`allow`: in all three cases the approval window stayed; this matches a reported Claude Code bug),
a rewritten rule at project and machine level ✅.

**Measured after the spec was approved (round three):**

1. **Safety ✅:** if the hook server is not running, or stops while holding, the native prompt
   stays, and on "Yes" the tool runs. Claude Code takes the failed hook as "no decision".
2. **The question answer format:** free text ✅ (shown under "Other" in the UI). Multi-select: as
   an array the session understands it correctly, but the UI shows it as "Other"; the approve
   milestone sends the documented text joined with `", "`, and the acceptance test checks it.
3. **An answer from the phone ✅:** `PostToolUse` arrives with the answer and the `tool_use_id`,
   so the daemon can close the row.

## 11. Milestones

**Monitor milestone (read-only). ✅ Done (2026-10-08), in daily use.** Discovery, status, the
`Notification` hook with the prompt's text, jumping to the window (`code -r` for a VS Code process
with several windows; since changed: the CLI runs without `-r` since 2026-10-25, see §7 and
`focus-window.ts` `codeCliCommand`), a configurable hotkey, tray + overlay, lossless install and
uninstall. Limits: they do not work in the extension (§3.5). Session discovery proved stable in
daily use (14 sessions, with correct window choice even with one shared VS Code pid).

**Approve milestone. ✅ Done (2026-10-20).** Built: allow, deny with a reason, project and machine
level rule, answering a question, rejecting a plan; the acceptance test (cases A to M) ran.
Follow-up fixes: status dots, the Remote Control dot, a button row fixed at the bottom, selecting
the oldest waiting session (with optional automatic hiding), the fixes from the whole branch's
review, and after a restart the registry-based waiting state (§3.1). For a file write (Write, Edit,
MultiEdit, NotebookEdit) the panel shows a preview: the new content, or `-`/`+` lines (the "diff
summary" of §5), with a size limit.

The original plan: the `PermissionRequest` + `PreToolUse` + `PostToolUse` hooks, `DecisionModel`,
`DecisionBroker`, the overlay's decision surface (the table in §5): allow, deny with a reason,
project and machine level rule with an editable preview, answering a question, rejecting a plan
with feedback. The first step was measuring the open points of §10. The never-firing
`SessionStart` HTTP hook is dropped from the monitor milestone's install (the uninstall still
recognises and removes the old entry).

**Tab focus milestone. ✅ Done (2026-10-21), without an extension of our own.** Reading the code
before measuring found Claude Code's own URI handler (§7, "Tab focus"); measured live, after the
right window is brought up it switches to the exact tab. The planned companion extension was
therefore dropped; the decision surface inside VS Code had already been removed (2026-10-20).

~~**Next:** reading the subagent transcripts (`subagents/agent-*.jsonl`).~~ Done (2026-10-21,
`0eee9b1`): the row shows the running subagent's current step too.

**The full repository review (2026-10-25) and its fixes.** ✅ The first six rounds of fixes are
done, the seventh (the Electron upgrade) is next. (Since changed: the Electron upgrade is done,
Electron 45, see §4 and `apps/desktop/package.json`.)

## 12. Risks

| Risk | Impact | Handling |
| --- | --- | --- |
| The `sessions/` and `ide/` formats are undocumented and can break on a version change | the list breaks | §8 layering: approving does not depend on it; schema validation, graceful degradation |
| The hooks go into the global `~/.claude/settings.json` → they affect every session | a wider blast radius than the app | the native prompt lives while the hook is held (§3.4); a stopped or crashing daemon, as measured, neither blocks nor denies (§8) |
| ~~The interception takes the prompt away from Remote Control~~ | — | measured: it does not (§3.7) |
| ~~Introducing a statusLine hides the footer hints~~ | — | the statusLine is retired (§3.5) |
| A too broad rule is added at project or machine level | a lasting, unintended permission | the rule appears editable, and the machine level asks for a separate confirmation |
| The app "allows" a question without an answer | the session goes on with a wrong assumption | the `DecisionModel` gives `allow` for a question only with a chosen option |
| Undocumented behaviour changes with a Claude Code update | a feature breaks silently | the raw hook log (`CLAUDESWITCHER_HOOK_LOG`) shows it quickly; the contract tests rest on the measured payloads |

## 13. What we deliberately do not build

- Remote Control as a transport (cloud, an undocumented client protocol).
- Using the `messagingSocketPath` named pipe (an undocumented peer protocol; it would be good for
  sending prompts, which is not a goal).
- An auto-approve / turbo mode. If it is ever needed, its place is the `DecisionBroker`.
- Starting or stopping sessions, sending prompts.
- Cross-platform support.
