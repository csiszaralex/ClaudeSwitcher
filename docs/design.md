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
The pairing looks only at the cwd (core `liveness.ts` `resolveLiveSessions`), so a terminal session
whose cwd is inside an open workspace gets that window's lock too, wherever it really runs.

#### The window title and the tab title (measured 2026-11-19, Claude Code 2.1.325)

Measured with `scripts/measure/title-watch.ps1` on VS Code for Windows, read only:

- All VS Code windows belonged to one process: every window had the same pid. The pid says "this is
  that VS Code", not which window.
- The window title contains the active editor's title (`${activeEditorShort}`). For a Claude Code
  tab that is the session's tab title. A tab switch in the foreground window (mouse, Ctrl+Tab,
  split editor groups) changes the window title at once; after a window switch (Alt+Tab, the
  taskbar) the foreground window's title already shows its active tab. A file tab shows the file
  name instead.
- The tab title is the transcript's latest `{"type":"custom-title","customTitle":…}` when the user
  renamed the session, else the latest `{"type":"ai-title","aiTitle":…}`. The custom title wins
  even when `ai-title` records come after it (a renamed session kept showing its custom title while
  its later `ai-title` records said something else). Both records are written again at the end of
  every turn, next to `last-prompt`.
- A long title is cut: the first 24 characters, then `…` (U+2026). "Claude Code session manager
  app" showed as "Claude Code session mana…"; a 10 character title showed whole.
- A new tab shows "Claude Code" before the first prompt, then the prompt text for about 2 s, then
  the AI title.
- The window title template is the user's `window.title` setting. The owner's is
  `${rootName}${separator}${activeEditorShort}`. The VS Code default on Windows (VS Code source,
  `src/vs/workbench/browser/parts/titlebar/windowTitle.ts`, `defaultWindowTitle`, separator
  `' - '`) is
  `${dirty}${activeEditorShort}${separator}${rootName}${separator}${folderLocation}${separator}${profileName}${separator}${appName}`.
  So the title cannot be parsed by position or by separator.

Read only, from the owner's transcripts (2026-11-19, 107 session transcripts under
`~/.claude/projects`): 101 had an `ai-title` record and 11 a `custom-title` record, every one a
non-empty string with only `type`, the title field and `sessionId`. The latest title record was at
most 33 904 bytes before the end of its file, well inside the 256 KB tail the scanner reads
(`transcript.ts` `tailLines`). In 10 of the 11 renamed sessions `ai-title` records came after the
last `custom-title` record.

Not measured: sessions outside VS Code (a CLI in a terminal), and where exactly the cut starts (a
title of exactly 24 or 25 characters).

The app reads the tab title in core `tab-title.ts` (the record names and the precedence) and
`transcript.ts` `readActivityFromLines` (`SessionActivity.tabTitle`).
Desktop `main/seen-elsewhere.ts` counts a finish as seen when the foreground window, a window of
the session's VS Code process, shows the session's tab title for `SEEN_DWELL_MS`: as a whole piece
of the title, or cut, by prefix, so it works with any template that contains `${activeEditorShort}`.
The dwell was 1.5 s at first, read every 0.5 s. Measured with `scripts/measure/title-watch.ps1` on
2026-11-19, the owner looked at a finished tab for 0.5, 0.85 and 1.6 s, so most glances never
counted. It is 1 s now, read every 0.25 s (`SEEN_DWELL_MS`, `SEEN_POLL_MS`). The cost of one read,
measured outside Electron with the same koffi bindings: 0.6 µs for the Win32 calls and 4.8 µs for
the match over 12 sessions.

#### Mapping to terminal windows (measured 2026-11-16, Claude Code 2.1.325)

A terminal session (`entrypoint: "cli"`) has no lock file of its own. Measured read-only on five
`cli` sessions: two in VS Code's integrated terminal, two as tabs of one Windows Terminal window
(one started as `pwsh` from the Start menu, which Windows hands over to Windows Terminal, one
started inside Windows Terminal), and one in `cmd`, which opened in a second Windows Terminal
window. The registry record's `pid` is the session's `claude` process; its parent chain
(`Win32_Process`):

| Host | Chain from `claude.exe` up |
|---|---|
| VS Code integrated terminal | pwsh → Code.exe (pty host) → Code.exe (main) → explorer |
| Windows Terminal, started inside it | pwsh → WindowsTerminal.exe → svchost |
| Default-terminal hand-off (Start menu `pwsh`, `cmd`) | pwsh or cmd → explorer |

So the chain alone does not find the window: after the hand-off Windows Terminal is not in it, and
VS Code's main process owns all of its windows (its `MainWindowHandle` was another window). The
windows do: every session's shell (the `claude.exe` parent) owns a hidden top-level
`PseudoConsoleWindow`, and that window's owner (`GetWindow(GW_OWNER)`) is the top-level window that
shows the terminal: the right VS Code window (`Chrome_WidgetWin_1`) for the integrated terminal,
the right Windows Terminal window (`CASCADIA_HOSTING_WINDOW_CLASS`) otherwise.

The rule (`focus-window.ts` `ancestorChain`, `findTerminalWindow`): from the session's process up
its ancestors, the first one that owns a `PseudoConsoleWindow` gives that window's owner. If that
pseudo console has no owner, the result is no window: a farther ancestor's console shows another
terminal. A classic console host without Windows Terminal would own a visible `ConsoleWindowClass`
window itself; that window counts then (not seen in the read-only measurement, where the
`ConsoleWindowClass` windows were hidden ones of background console programs, and a hidden one
does not count; in the owner's live test on 2026-11-17 a session in `conhost.exe pwsh` came
forward, which path found it was not recorded). The jump
uses this first for every session whose `entrypoint` is known and is not `claude-vscode`
(`focusWith`), instead of the lock's pid: by the cwd pairing above that pid may be a VS Code window
the session does not run in. Only when the console search finds nothing and the lock's pid is in
the session's ancestor chain does such a session go the VS Code way (the lock's pid, then the `code`
CLI): it then runs under that VS Code, for example a `claude -p` started by an extension session's
tool. Measured 2026-11-17 (`Win32_Process`): eight extension sessions ran as `claude.exe` →
Code.exe (extension host) → Code.exe (the lock's pid), and a `cli` session in the integrated
terminal as `claude.exe` → pwsh → Code.exe → Code.exe (the lock's pid). So a process an extension
session starts has the lock's pid in its chain as long as the chain is unbroken (not measured with
a real `claude -p`), and a CLI in the integrated terminal whose console search misses falls back
too. One VS Code main process owns every window (all its locks carry the same pid), so the fallback
brings up the window the cwd pairing chose, which need not be the window whose terminal runs the
session. A session in Windows Terminal does not have the lock's pid in its chain (the table above).

Not reachable this way: the exact tab. Windows Terminal comes forward on its current tab, and VS
Code comes forward without opening its terminal panel on the session's terminal.

Git Bash can break the chain (measured 2026-11-17 with Git for Windows' bash and sh, read-only
`Win32_Process`). An MSYS program that an MSYS process starts through `exec` gets a new Windows
process whose recorded parent has already exited: `sh` started from bash, and a bash started
inside bash, each had a parent that was no longer listed. An MSYS process that `exec`s a native
program stays alive as its parent. So `claude` installed by npm, whose sh shim bash runs and which
ends in `exec node`, has the chain node → sh shim and nothing above it, and a session in a bash
started inside another bash stops at that inner bash. In both cases the chain ends before the shell
the terminal started (in the measurements above the owner of the pseudo console), and the jump finds
no window, never a wrong one. Which process owns the pseudo console of a Git Bash tab was not
measured. The native `claude.exe` measured above, started from pwsh or cmd, has its shell as its
direct parent.

Observed in the owner's live test on 2026-11-17 (ClaudeSwitcher 0.7.0): a session started with the
native `claude.exe` in a Git Bash tab of Windows Terminal did not come forward. Its parent chain and
the windows of its processes were not recorded, so which step failed (the chain, the console search
or bringing the window forward) is not known. Git Bash in VS Code's integrated terminal was not
tested.

### 3.3 Transcript

`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, appended live. Record types in the real
file: `queue-operation`, `user`, `attachment`, `file-history-snapshot`, `ai-title`, `atis-latch`,
`assistant`, and more. Little of it is needed; **an unknown type is skipped, it must never throw.**

#### The usage limit record (measured 2026-11-18, Claude Code 2.1.326)

When the account hits its 5-hour limit, Claude Code ends the turn and writes one synthetic
`assistant` record into the transcript (ids and paths left out):

```json
{"type":"assistant","isSidechain":false,"timestamp":"2026-11-18T19:10:51.528Z",
 "message":{"model":"<synthetic>","role":"assistant","type":"message","stop_reason":"stop_sequence",
   "content":[{"type":"text","text":"You've hit your 5-hour limit · resets 10:20pm (Europe/Budapest)"}]},
 "apiError":"usage_limit_reached",
 "apiErrorParams":{"rate_limit_info":{"status":"rejected","resetsAt":1795036800,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}},
 "quotaLimits":{"status":"rejected","resetsAt":1795036800,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false},
 "error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"apiErrorType":"rate_limit_error",
 "entrypoint":"claude-vscode","version":"2.1.326"}
```

- `resetsAt` is in Unix seconds (1795036800 is 2026-11-18 21:20 UTC, 22:20 in Budapest).
- The `StopFailure` hook fires too; the app routes it like `Stop` (core `hook-contract.ts`). Its
  payload was not logged.
- **The weekly limit**, read afterwards from older transcripts of the same machine (2026-09-16,
  Claude Code 2.1.268, not provoked on purpose): `rateLimitType: "seven_day"`, the text "You've hit
  your weekly limit · resets …". These records carry `quotaLimits` but no `apiError` and no
  `apiErrorParams`; a 5-hour record of the same version has the same shape. The weekly record of a
  current version was not seen.
- Records with the same `error: "rate_limit"` from 2.1.224 have no `quotaLimits` at all. The app
  does not recognise them.
- In every transcript seen, the next message record after the limit is a `user` record, when the
  user writes again (`queue-operation` and `attachment` records can come between).
- Other synthetic error records (`error: "server_error"`, `"authentication_failed"`) have
  `isApiErrorMessage: true` too, without `quotaLimits`.

The app reads it in core `usage-limit.ts` `usageLimitOf` (the field names) and `transcript.ts`
`readActivityFromLines` (`SessionActivity.usageLimit`, cleared by a later `user` record or a
non-error `assistant` record). The limit record's text does not become the row's text; the text of
the other error records still does.

#### Cross-session messages (measured 2026-11-19, Claude Code 2.1.325)

One session can prompt another with Claude Code's `SendMessage` tool. The owner talks to one
orchestrator session, which hands work over to others this way, and its own turn ends right after
the send. Measured on the owner's transcripts of the last 7 days with
`node scripts/measure/cross-session.mjs 7`:

- 14 sessions sent or got messages; 486 of 500 `SendMessage` calls were linked to their arrival.
- One hub talked to 6 sessions, but the others talked to each other too: a mesh, not a tree.
- 472 of the 486 messages got a message back from the recipient (p50 5.4 min, p90 47.8 min).
- In 382 of the 486, the sender's turn had ended while the recipient still worked on the message
  (p50 1.7 min, p90 11.7 min): the sender's row showed a finished ✓ meanwhile. The hub had up to 6
  recipients working at once.
- The `hop-chain` attribute is no task id (114 chains, median 2 messages, some lasting days; counted
  separately, the script does not count chains).

A rerun a few hours later, with the 7-day window moved on, gave 490 of 504 linked, 386 finished
senders and 475 replies, and the same times within 0.1 min.

The records, read from 611 arrivals in 25 transcripts (2026-10-18 to 2026-11-19, Claude Code
2.1.301 to 2.1.328, most of them 2.1.325); invented values:

- **The sender's pipe.** The registry (§3.1) has `messagingSocketPath`, for example the JSON string
  `"\\\\.\\pipe\\LOCAL\\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9"`.
- **The arrival.** In the recipient's transcript a message arrives as
  `{"type":"queue-operation","operation":"enqueue","content":"<cross-session-message from=\"uds:\\\\.\\pipe\\LOCAL\\cc-msg-…\" hop-chain=\"…\" from-name=\"Orchestrator\" from-mode=\"prompting\">\n…"}`,
  `hop-chain` optional. `from` is `uds:` and the sender's `messagingSocketPath`, character for
  character: of the 734 `from` values in `enqueue` and `remove` records, 576 matched a pipe in that
  day's registry, the others no current entry.
- **The delivery.** Every arrival was taken up in one of two ways:
  - mostly when the recipient was idle (488): a `queue-operation` `dequeue`, then a `user` record
    with `isMeta: true` and `origin: {"kind":"peer","from":"uds:…","msg_id":…,"name":"Orchestrator","fromMode":"prompting","body":…}`.
    It starts a turn.
  - mostly when the recipient was busy (123): an `attachment` of type `queued_command` with the
    same `origin`, and a `queue-operation` `remove` with `reason: "absorbed_mid_turn"`. The message
    joins the running turn. A message that arrives during a turn that then ends without absorbing
    it is dequeued right after that turn's end and starts the next one.
- **The end of the turn that handles it.** The app knows a turn's end from the `Stop` hook
  (`SessionView.stoppedAt`); in the transcript it is an `assistant` record with
  `message.stop_reason: "end_turn"`, or a synthetic one (`message.model: "<synthetic>"`, an API error
  or the usage limit, §"The usage limit record"). Every delivery was followed by one. A turn the user
  interrupts ends without either (2 of 611 deliveries).
- **Not a cross-session message.** A `peer` origin whose `from` has no `uds:` prefix (a 17-hex id,
  with `senderTaskId` and `handback`) is a subagent handing its result back inside the same
  session.
- **The transcript tail is not enough.** Between a delivery and the end of its turn the transcript
  grew by 53 KB at the median, 748 KB at p90, 4.7 MB at p99 and 9.0 MB at most; 138 of the 611
  outgrew the 256 KB tail the activity is read from.

The app reads it in core `cross-session.ts` (the record format, `createPromptTracker`) and
`transcript.ts` (`readActivityFromLines`, `SessionActivity.promptedBy`): a sender is pending from
its arrival until the end of the turn that handles it, one entry per sender, its pipe without
`uds:`. When the tail holds no turn end, `readTranscriptActivity` reads back to the last one, at
most `PROMPT_LOOKBACK_BYTES` (16 MB), and keeps only the lines that may be one of these records.
Replayed against a fold of each whole transcript at 654 sampled points (429 of them with a pending
sender), it agreed at every point; the tail alone missed the sender at 185 of the 429. The lookback
of the full 16 MB took 19 ms.

The desktop app links the sessions with it (`shared/prompt-links.ts`): a session whose turn has
ended **waits on** the other live sessions whose `promptedBy` names its `messagingSocketPath` and
that work or wait (`shared/session-finished.ts` `waitsOn`). While it waits on any it is not
finished: the list shows ◌ and "Vár: …" instead of the ✓, the tray counts it as working, and the
"végzett" toast comes only when the last recipient is idle, once per `stoppedAt`. The check is one
step deep. A recipient that finished and waits on others is idle, and its own turn that handled the
message has ended, so its `promptedBy` no longer names the sender anyway. The rule therefore cannot
loop in a mesh. A turn the user interrupts (see above) leaves its senders pending until the next turn
end, but the recipient is idle then, so nobody waits on it; only its next turn's row note names
them.

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
- **Headless runs** (measured 2026-11-15, Claude Code 2.1.325): `claude -p` with a command that needs
  permission wrote a registry record with `entrypoint: "sdk-cli"` and `kind: "interactive"`, so
  `kind` does not tell a headless run apart; the record also had a derived `name`. While its
  `PermissionRequest` was pending, `status` was `busy`, not `waiting`. The request reached the
  app and showed as a normal waiting row, indistinguishable from a VS Code session's (the VS Code
  session in the same folder: `entrypoint: "claude-vscode"`, `kind: "interactive"`). The SDK
  runs (`sdk-ts`, `sdk-py`) were not measured. The app labels a request from the `entrypoint`
  (`shared/request-source.ts`) and does not read `kind`.
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

### 3.9 Sending a message to a running session (measured 2026-11-17, Claude Code 2.1.326)

The question was whether the app can answer a finished session in the user's name, for example
"OK" to a "Mehet?". That would be a one-click reply, a text box in the list, or chatting from a
phone.

- **The most promising way.** A `Stop` command hook with `asyncRewake: true` runs in the
  background. The hooks reference says such a hook "exits with code 2 wakes Claude immediately even
  when the session is idle" (https://code.claude.com/docs/en/hooks). Claude Code also enforces its
  `timeout`.
- **What was measured.** The test session ran in the VS Code extension (entrypoint
  `claude-vscode`). The hook waited for a file in the test project and, once it appeared, exited 2
  with the file's text on stderr.
  - The idle session started a turn at once, without the tab being touched.
  - The transcript records that turn as a `user` entry with
    `origin.kind: "task-notification"` and `promptSource: "system"`.
  - The text reached the model as `Stop hook blocking error from command "Stop": <text>`. Claude
    Code wrapped it in `[SYSTEM NOTIFICATION - NOT USER INPUT] ... Do NOT interpret this as user
    acknowledgement, confirmation, or response to any pending question.`
  - The model answered that a Stop hook sent the "mehet", not the user, so it did not take it as
    the answer to its question.
- **The consequence.** An outside program can wake a session, but it cannot speak as the user.
  This is a deliberate guard of Claude Code, and the app does not work around it.
- **Not tried, for the same reason.** Writing keystrokes into the session's console would pass as
  the user's typing. It works only for terminal sessions, races with what the user types, and would
  sidestep that same guard.
- **The other ways do not deliver a message into the open session.**
  - The extension's URI (§7, "Tab focus") can carry a prompt, but only to pre-fill it. For a
    session whose tab is already open, extension 2.1.326 says "Session is already open. Your prompt
    was not applied — enter it manually."
  - `claude --resume` starts another process on the session.
  - Remote Control is a cloud service (§3.7).

So the user's answers reach a session only through the hooks Claude Code asks: `PermissionRequest`
(§3.4), which carries the decision of a permission request or a question.

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

**Form factor:** a tray icon + a global hotkey overlay. Normally invisible; the tray icon's colour
shows what waits and its tooltip the number of waiting sessions (README, "The tray"), and the
hotkey brings up a compact list.

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
  freshly shown panel, or for a short time after typing (`key-guard.ts`);
- added later: Ctrl+K opens the list's search (`session-search.ts`, README "Searching the list").
  In its field the arrows, Enter and Esc act on the matches, and the first Esc closes the search.

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
                           to the "decide at the session's own prompt" state, the prompt stays
```

**The overlay offers different things by the kind of request:**

| `tool_name` | The overlay shows | Buttons | Answer to the hook |
|---|---|---|---|
| Bash, PowerShell, WebFetch, MCP, … | the tool, the input, who asks (session or subagent); for a Bash command that runs git, one line per git call saying what it does, the dangerous ones marked | Allow · Deny (with a reason) · Project level · Machine level | `allow` / `deny`+`message` / `allow`+`updatedPermissions` |
| Write, Edit | the file, a diff summary | Allow · Deny · For this session automatically | `allow` / `deny` / `allow`+`setMode acceptEdits session` |
| AskUserQuestion | the questions and the options | option choice (several for multi-select), free text → Answer | `allow`+`updatedInput.answers` (key: the question's text, value: the option label; several labels joined with `", "`; free text verbatim) |
| ExitPlanMode | the plan's text | Reject with feedback · **"Jóváhagyás a VS Code-ban"** (approve in VS Code: jumps there; for a terminal session "a terminálban") | `deny`+`message`; it cannot be approved from the hook (§10) |

**Project and machine level rule.** Claude Code's suggestion (`permission_suggestions`) **appears
editable**; the user can rewrite it (narrow it), and Claude Code itself writes the approved
version (`localSettings` / `userSettings`). The app writes no settings file. The machine level
option asks for a separate confirmation, because it affects every session.

**A late click.** If the decision has already been made (from any source), the overlay's row
disappears; a click that arrives meanwhile is a no-op. After a release the row stays, but only
with the "Ugrás a VS Code-ba" (jump to VS Code) button ("Ugrás a terminálhoz" for a terminal session,
"Ugrás a sessionhöz" for an unknown source: `shared/request-source.ts` `sessionHost`).

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
  running tool, a timestamp, the usage limit that ended the turn, §3.3). Skipping an unknown record
  type is mandatory.
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
- Starting or stopping sessions, sending prompts. Claude Code does not take a prompt from outside
  as the user's (§3.9).
- Cross-platform support.
