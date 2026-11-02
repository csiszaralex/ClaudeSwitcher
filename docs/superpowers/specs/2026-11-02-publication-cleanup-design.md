# Wave 8 part 2: clean-up for publication

Part 2 of wave 8 (the order is in `2026-10-31-installer-design.md`, "Wave 8 as a whole"). Part 1, the installer, is on `main` (`08ae6a8`). Part 3 rewrites the history, part 4 makes the repo public.

## Why

The repo goes public in part 4. Today it is written for one person and his agents: comments and docs are mostly Hungarian, the README describes how Alex runs it, and a few modules grew while features were added.

**Who opens it (Alex):** a friend, or a developer with the same problem: many Claude Code sessions running at once, which they want to supervise in the background, for example while watching a film, without switching windows all the time and without missing a session that waits for approval. They need:
1. a little motivation: what situation the app solves;
2. how to install and use it;
3. how to develop it, if they want to.

**Success:** that reader understands from the README what the app is for and gets it running. A contributor finds the rules in `CONTRIBUTING.md` and code they can read in English, with no module they must fully understand before they can change one thing.

## Inputs

Three read-only recon reports from 2026-11-02, local and gitignored: `.superpowers/sdd/2026-11-02-cleanup-recon/srp.md`, `dry.md` and `language.md`. Each finding there names its file, symbols, a failure scenario and a fix. This document decides which of them are in scope. Where a report and the code disagree, the code wins.

## Goals

### A. Code structure (SRP, DRY)

In scope, as the reports describe them unless stated otherwise:

1. **One IPC contract.** The channel names and the reply types live in `apps/desktop/src/shared/` and are used by `main`, both preloads and the renderer, with one registration helper for `ipcMain.handle` plus its sender check. (srp 4, dry 1.) The two preloads must not end up sharing a generated chunk: a sandboxed preload cannot load one. The build output in `out/preload` shows it.
2. **The quit sequence out of `index.ts`** into its own module (`quitting`, `cleanup`, the instance record removal, the `before-quit` handler), with unit tests for the order: daemon stop within `STOP_TIMEOUT_MS`, then the record removal, then the real quit, and a second quit request that starts nothing new. (srp 1.)
3. **The hotkey state out of `index.ts`** (`heldHotkey`, the capture, `switchTo`), with unit tests. (srp 2.)
4. **The overlay window out of `index.ts`** into `overlay-window.ts`, the same shape as `setup-window.ts`. The secure `webPreferences` and the dev-server or file loading branch become one helper both windows use. (srp 3, dry 5.)
5. **One testing entry for shared test helpers:** the fixture loader for `hook-payloads.json` (one behaviour, including a clear error for a missing fixture name), `tempDir`, the fake alive probe and the claude-dir writers. It is dev-only and never part of a runtime bundle. (dry 2.)
6. **Smaller duplications:**
   - text flattening and truncation in one place (dry 4);
   - the daemon host, WS path and token parameter as constants, with a test that the renderer CSP literal agrees (dry 6);
   - the hook-server route boilerplate and `LIFECYCLE_KINDS` derived from `HOOK_CONTRACT` (dry 7, srp 12);
   - the renderer's settings fallback from `DEFAULT_SETTINGS` (dry 8);
   - one token format, used by the daemon, `token.ts` and `TOKEN_PATTERN` (dry 9);
   - a test that reads `installer.nsh` and checks its exit codes and flags against `LAUNCH_EXIT_CODE` and the launch flags, which get one home (dry 10);
   - the subagent file layout and the `projects` directory in core `paths.ts` (dry 11);
   - the small guards (dry 13), an `errorMessage` helper (srp 11);
   - CSS variables for the repeated colours (dry 14);
   - the config restatements (dry 15);
   - the daemon broker's `resolvingFor` side channel replaced as srp 6 describes;
   - `DecisionPanel.tsx`: one table for the decision buttons and their key letters (srp 7).
7. **Renames:** `main/setup.ts` (the Claude Code hook integration) becomes `claude-integration.ts`, because "setup" also names the settings window (srp 10).
8. **Wrong or stale statements fixed:** the two timing comments (dry 12) and the `CLAUDE.md` index drift (dry 3).

### B. English everywhere except the GUI

- All code comments, `describe` titles, non-GUI log and error texts, the ESLint config messages and the spikes' texts are translated (`language.md`: about 1900 comment lines). Translate the meaning, not word by word, and drop a comment that only restates the code.
- GUI strings stay Hungarian: the renderer, the tray, dialogs, the installer, and the user-facing refusal texts `language.md` lists as GUI.
- Test data stays as it is, Hungarian included: the measured `hook-payloads.json` fixture (a measured artefact, and part 3 handles its prompts) and the invented sample strings in tests (`'Mi a kedvenc színed?'`). Only comments and `describe` titles in tests are translated.
- This runs after A, so a moved module is translated once.

### C. Docs

- **`README.md`, in English,** in three layers:
  1. **Motivation:** the problem in a few sentences.
  2. **Use:** install, first start, what you see. It states that the GUI is Hungarian, and that it runs on Windows with Claude Code in VS Code. Until part 5 publishes Releases, installing means building the installer from source (`pnpm --filter @claudeswitcher/desktop dist`, unsigned, SmartScreen's "More info, Run anyway"); part 5 rewrites this step to download from Releases.
  3. **Development:** pointing to `CONTRIBUTING.md`.

  Alex supplies a screenshot or GIF of the overlay. Agents cannot launch the app.
- **`CONTRIBUTING.md` (Alex's choice),** for humans: how to run from the repo, the architecture (packages and how a hook travels to the overlay and back), and the rules: strictness, `pnpm verify` and the git hooks, no synchronous child processes, renderer imports, one fact in one place, Conventional Commits with one scope, invented data in tests. It is the one home of:
  - the "one fact in one place" module index;
  - the Claude Code coupling points list (where each undocumented internal is read), which a human tracing a Claude Code change needs as much as an agent;
  - the code-relevant environment notes: why the renderer root is a real path (`RENDERER_ROOT`, a `subst` drive), why `@types/node` follows Electron's Node, the generous timeouts for slow machines.
- **`CLAUDE.md`** stays as the rules for agents, in English, short, and points to `CONTRIBUTING.md` for everything above instead of repeating it. After every code move the coupling points list in `CONTRIBUTING.md` is kept correct.
- **`CLAUDE.local.md`** (gitignored, which Claude Code loads next to `CLAUDE.md`) gets the personal workflow: Alex's OK gates, the cs-spike live test protocol, the hands-off rules about his machine and his real `~/.claude`, and the facts about this one machine (the `P:` drive, slow process starts, `pnpm verify` taking minutes).
- **No local data in new text.** Text that part 2 writes or translates is written without the name, paths or ids: "measured live" instead of "measured by Alex", "a test project" instead of the cs-spike path. Real values in text that is only moved stay for part 3, and so do the fixture and the commit hashes the docs cite.
- **The main design (`docs/superpowers/specs/2026-09-04-claudeswitcher-design.md`)** is translated and moves to `docs/design.md`. It holds the measured Claude Code behaviour the coupling points depend on. `spikes/m2-permission/RESULTS.md` is translated in place.

### D. Working documents out of the public tree (Alex: delete them or move them to a gitignored folder)

Move to a gitignored `docs/archive/`, so they stay on Alex's machine and agents can still read them:
- `docs/superpowers/plans/` (the M1, M2 and installer plans);
- `docs/superpowers/specs/` except the main design (the installer design and this document);
- `docs/reviews/2026-10-25-repo-review.md`;
- `docs/backlog.md`;
- `spikes/m2-permission/SCENARIO.md`.

The open backlog items become GitHub issues in part 4. Until then, the backlog in the archive is the only copy, with no backup: Alex knows this. Every reference to a moved file is updated or dropped: `README.md`, `CLAUDE.md`, the main design, and code comments (for example the "backlog item 8" comment in `electron.vite.config.ts`). `docs/archive/` and `CLAUDE.local.md` are added to `.gitignore`.

This design and its implementation plan are committed on the branch like the earlier ones (a `docs` commit before the work), and D archives them with the rest.

## Non-goals

- **GUI i18n** (backlog item 13): later, separately.
- **Real local data in the tree** (the fixture's session ids, the cs-spike path, the name "Alex"): part 3 replaces them in every commit at once. Part 2 neither adds new ones nor touches the existing ones. The archived files stay in the old commits until part 3 decides what to do with them.
- **Extracting the launch and hand-over path from `index.ts`** (srp 5): the riskiest code, live-tested on 2026-11-02. Later, if ever, with fake-lock tests first.
- **Splitting `liveness.ts` and `focus-window.ts`** (srp 8, 9): already testable, so a split would only move code.
- **A LICENSE, CI, issue templates:** part 4.

## Anti-goals

- **No behaviour change.** Hook timing, the quit order, the hand-over, the hotkey and the installer must behave exactly as today. A refactor that needs a behaviour change to work is out.
- **No loosening:** strictness, `knip` and the ESLint rules stay as they are.
- **No mixed commits:** a move and a translation never share a commit, so a diff stays reviewable.

## Constraints

- `pnpm verify` is green at every commit. Each independent change is its own commit (Conventional Commits, one scope).
- The code changes of A get one combined live test by Alex, after all of A and before B starts (A6 also touches runtime code: the hook routes, the token, the daemon address), with an exact protocol: overlay, hotkey and capture, a permission decision, tray quit, `--quit`, a hand-over, and an install over the running app. Each is still its own commit after Alex's OK on its diff; a regression is traced to its commit by the lead.
- The coupling points list (in `CONTRIBUTING.md`, see C) stays correct after every move, because it is where a Claude Code change is traced first.

## Decided by Claude (not asked)

- The order is A, B, C, D. D last, so the work itself can still read the plans.
- `CLAUDE.local.md` for the personal workflow, instead of a second rules file.
- `docs/design.md` as the translated main design's new home.
- Part 3 handles the local data already in the tree, so it is replaced once and consistently; new text carries none.
- Test data and the measured fixture stay untranslated.
- The coupling points list, the module index and the code-relevant environment notes live in `CONTRIBUTING.md`; machine facts go to `CLAUDE.local.md`.
- The README's install step is build-from-source until part 5.
- One combined live test after the runtime refactors, instead of one per refactor.
- This design and its plan are committed, then archived by D.

## Left to the builder

- The exact module and constant names, and where each shared helper lives, within the project's existing patterns (core shared modules exported through `/browser` only when they have no `node:` import).
- How to batch the A6 items into commits, one per independent change.
- The translation granularity per commit (per package or per directory).
