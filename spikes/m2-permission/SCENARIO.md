# Permission spike: scenario

Goal: to **measure** the design's open questions in the VS Code extension before the decisions
from the app are designed. The spike folder (`CS_SPIKE_DIR`, see `WORKSPACE` in `server.mjs`) gets
its own project-level `.claude/settings.json`, so the hooks act **only on a session opened in that
folder**. Your global configuration and your other running sessions are untouched.

## Preparation

1. **A new PowerShell window: this is the server.** Keep it open, it prints live what arrives (from the repo root):
   ```powershell
   node spikes\m2-permission\server.mjs
   ```
2. **A second PowerShell window: with this you switch modes** between the phases (from the repo root):
   ```powershell
   cd spikes\m2-permission
   node server.mjs mode pass
   ```
3. **VS Code:** *File → Open Folder* → the spike folder (in a new window). If it asks about
   trust, accept. Open a **new** Claude Code session.
4. **Below the input box, switch the "Edit automatically" mode to "Ask before edits".**
   Without this, file writes and edits ask no permission, and we cannot measure them.

## A. Does it run at all? `mode pass`

Here the server does not decide, it only logs. Answer every prompt in VS Code with **"Yes"**
(not the "don't ask again" variant). Ask the session for these, one after the other:

1. `Run this with the Bash command: echo spike-a > a.txt`
2. `Create a file b.txt with the content "hello"`
3. `Edit b.txt: change hello to szia`
4. `Fetch the page https://example.com with WebFetch`
5. `Call the getDiagnostics MCP tool`
6. Switch to **Plan** mode, ask: `Plan creating a c.txt`, then approve the plan.

Meanwhile watch the server window: does a `→ PermissionRequest` line come?

## B. Hold: `mode hold 60`

1. `Run: echo spike-b > b2.txt`
2. **Do not touch anything.** Watch: does the prompt appear in VS Code **at once**, or only
   **after** the 60 seconds are up? Write it down.
3. The server prints: `hold expired: empty 200`. If the prompt is still there afterwards, **wait
   two more minutes**, and only then press "Yes". Does the prompt wait that long?

## C. Parallel decision: `mode hold 60`

1. `Run: echo spike-c > c2.txt`
2. If the prompt appears **during the hold**, click "Yes" on it **at once**, before the server
   releases it. What happens? Does the command run? What does the server print after 60 s?

## D. Allow from the app: `mode allow`

1. `Run: echo spike-d > d.txt`
2. Expected: **no prompt**, the command runs.

## E. Deny: `mode deny`

1. `Run: echo spike-e`
2. Expected: it does not run, and the session knows why we denied it.

## F. Subagent: `mode pass`

1. `Start a subagent that runs this with Bash: echo spike-f > f.txt`
2. "Yes" on the prompt. In the log we look at whether the PermissionRequest has an `agent_id`.

## G. Phone (Remote Control): `mode hold 90`

1. Open this session on the phone.
2. `Run: echo spike-g > g.txt`
3. Watch the phone: does the prompt show there **during the hold**, and **after** it?

## At the end

`Ctrl+C` in the server window. Then summarize the log (`spike-log.jsonl`) with
`node server.mjs summary`.
