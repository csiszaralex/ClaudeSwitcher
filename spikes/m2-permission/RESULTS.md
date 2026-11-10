# Permission spike: results (2026-10-08)

Measured live with Claude Code running in the VS Code extension (`entrypoint:
claude-vscode`), in a throwaway folder with project-level hooks.
Tools: `server.mjs` (raw log + a controllable PermissionRequest response) and `log-hook.mjs`
(its command-hook twin). Every claim rests on a timeline in `spike-log.jsonl`.

## The main question: can the app decide permission requests?

**Yes, and more simply than the design planned.**

| # | Question | Result |
|---|---|---|
| 1 | Does `PermissionRequest` run in the extension? | **Yes**, both as an HTTP and as a command hook: Bash, Write, Edit, WebFetch, MCP tool, ExitPlanMode, AskUserQuestion |
| 2 | What shows in VS Code while the response is held? | **The native prompt appears at once**, in parallel with the hold |
| 3 | After the release (empty 200)? | The prompt **stays and can be answered**: it still ran 2.5 minutes after the release |
| 4 | I decide in VS Code during the hold? | **Takes effect at once**; Claude Code ignores the app's late response |
| 5 | The app allows while the prompt is showing? | **The prompt disappears, the command runs in the same second** |
| 6 | Deny from the app | Works |
| 7 | Remote Control during the hold | **It appears on the phone too, and can be accepted from there** |
| 8 | Identifying a subagent | `agent_id` and `agent_type` **are in** the PermissionRequest (not in the Notification) |
| 9 | Rule suggestion | `permission_suggestions`: Claude Code itself gives the project rule (e.g. `Bash(echo x *)`, `WebFetch(domain:…)`) |
| 10 | Writing a rule from the app | `updatedPermissions` + `destination: localSettings` → **Claude Code itself writes it** into `.claude/settings.local.json` |

## What this makes unnecessary in the design

- **Lease model**: the native prompt never disappears, so there is nothing to "give back". The
  app can hold until the hook timeout, then send an empty 200: the prompt stays.
- **Presence policy**: holding takes the prompt away neither from VS Code nor from the phone.
- **RuleBuilder**: Claude Code gives the rule in `permission_suggestions`.
- **A SettingsWriter for rules**: Claude Code writes them itself on `updatedPermissions`.
  (The user-level `userSettings` destination was not measured: the spike did not touch the global
  configuration.)

## What the decisions from the app must watch for

1. **The connection does not tell us the native decision.** When the user decides in VS Code or
   on the phone, Claude Code **does not close** the held HTTP request. The app can remove the
   pending row on `PostToolUse` (same session + tool + input), and on a denial on the next
   `PreToolUse`/`Stop` or the timeout.
2. **`AskUserQuestion` also comes as a PermissionRequest.** The app must not "allow" it: the
   question would go on without an answer. Pass it through (empty 200), or handle it separately.
3. **So does `ExitPlanMode`**: approving here means accepting the plan, not a command.
4. **The `Notification` (permission_prompt) comes only after ~6 s of waiting.** Requests answered
   quickly do not show in the monitoring overlay; the PermissionRequest comes at once, so the
   decision panel does show them.
5. **`SessionStart` does not arrive as an HTTP hook, only as a command.** This affects the
   monitor's installation too: the HTTP hook of `SessionStart` never fires.

## Round two: after the decisions on the first round

After the first round it was decided that questions and plans **can be answered from the app
too**, and that there should be **user-level allowing with an editable preview**. Measured for
this (`custom` mode, the response from `respond.mjs` in the spike folder):

| # | Measurement | Result |
|---|---|---|
| K1 | Answering AskUserQuestion: `allow` + `updatedInput.answers` (the key is the question text, the value the option's label: the Agent SDK format) | ✅ **Works.** It went on in the same second, without a click, with the chosen option |
| K3 | Denying a plan: `deny` + `message` | ✅ **Works.** Claude rewrote the plan according to the feedback |
| K2 | Approving a plan: `allow` | ❌ The approval dialog still appeared 6 s later |
| K2b | Approving a plan: `allow` + `setMode default` | ❌ The same |
| K2c | Approving a plan from `PreToolUse` (`permissionDecision: allow`) | ❌ The PermissionRequest still ran, the dialog appeared |
| K4 | `updatedPermissions` with a rule **we made up** (not from the suggestion) | ✅ **Written** into `localSettings`, unchanged |
| K5 | The same with `destination: userSettings` | ✅ **Written into the global `~/.claude/settings.json`.** Afterwards only this one rule was removed; the file was bit-identical to the backup taken before the measurement |

**Consequences for the decisions from the app:**
- Answering a question from the app: **feasible**.
- Plan: **denying with feedback from the app is feasible; approving is not.** Three independent
  attempts failed, consistent with a reported Claude Code bug (an `allow` given from the hook is
  ignored for a plan). For approval the app takes the user to VS Code (or the phone).
  If Claude Code fixes it, a response branch has to be switched on in the app.
- Project- and user-level rules, **with an editable preview: feasible.** Claude Code accepts any
  rule we give and writes it itself; no settings-file writer of our own is needed.
- A measurement trap worth remembering: in `acceptEdits` mode a `> file` redirection counts as a
  file write and runs **without a permission request**, so the first attempt of K4 measured
  nothing. The second attempt used a command that writes no file (`node -e`).

## Round three: the design's open points (2026-10-08)

| # | Measurement | Result |
|---|---|---|
| R1a | Multiple-choice answer **as an array** (`["Alma","Banán"]`) | ✅ in content: the session understood it correctly. The UI, though, did not tick the two options but showed "Other: Alma,Banán". The Agent SDK documentation also mentions text joined with `", "`; the decision panel uses that, to be checked in the acceptance test |
| R1b | Free text that is not an option | ✅ Shows under "Other: …", the session understood it correctly |
| R2 | Answering a question on the computer, then on the phone (Remote Control) | ✅ In both cases `PostToolUse` came with `tool_response.answers` and `tool_use_id` → the daemon can close the row |
| R3 | The hook server stops during the hold | ✅ **The prompt stays and runs on "Yes".** No `PostToolUseFailure` |
| R4 | The hook server does not run at all | ✅ **Works exactly as without a hook** |

**Consequence:** Claude Code treats a hook that is unreachable or stops midway as "no decision",
not as a denial. So a crash or exit of the app never denies a command: the guiding principle of
the design's error handling rested on this.

## Left open

- **Does a written rule really prevent the next question?** The writing is certain. A command with
  a redirection run 3 minutes later in the same session asked again; the attempt in a new session
  cannot be evaluated (Claude Code ran it with PowerShell, so the `Bash(...)` rule did not apply to
  it in the first place). The same holds for the native "don't ask again" button: Claude Code's
  matching logic decides, not us.
- **A hook timeout longer than 600 s**: not measured; without the lease model it is not needed.
- **Folder trust**: did not come up.
