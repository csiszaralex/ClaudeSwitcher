# ClaudeSwitcher: rules for agents

What the app does: `README.md`. How to run it, the architecture, the rules for every change, the module index, the Claude Code coupling points and the environment notes: `CONTRIBUTING.md`. The design and the measured Claude Code behaviour: `docs/design.md`. This file adds only what applies to agents. A `CLAUDE.local.md` next to it, if present, holds the owner's personal workflow and the facts of one machine.

## Read first

- The rules in `CONTRIBUTING.md` ("Rules") bind agents too: strictness, `pnpm verify` and the git hooks, the bans ESLint enforces (synchronous child processes, value imports in the renderer), one fact in one place, Conventional Commits.
- Before adding a constant or a rule, find its home in the module index of `CONTRIBUTING.md`. After moving code, keep its Claude Code coupling points list correct.
- Do not loosen any strictness setting (`tsconfig.base.json`, `eslint.config.mjs`, `knip.jsonc`) without a stated reason and the owner's OK.

## Working

- One implementing agent works at a time. It stops at `git add`, stages exactly its task's files, reports the file list, and never commits.
- The lead verifies the work itself (`pnpm verify`, and the decisive claims in the code). A commit is made only after the owner's OK.
- One commit per independent change: Conventional Commits with exactly one scope, in English, with no AI attribution.
- When two commits touch the same file, the agent makes per-step snapshots in `.superpowers/sdd/<plan>/<task>-split/C<n>/`, with an `apply_step.sh` that sets the work tree to the state after commit n and stages exactly that commit's files, and a `verify_steps.sh` that runs `pnpm verify` for every step.
- Before anything is merged into `main`, the lead runs `pnpm verify` fresh on the HEAD of the branch to merge, and merges only on exit 0. The pre-push hook runs only on a push, so this run is required.
- Never bypass the git hooks (`--no-verify`, `SKIP_SIMPLE_GIT_HOOKS`) without the owner's OK.
- No `npx` (use `pnpm exec`, or `pnpm dlx` for a tool that is not a dependency). Change dependencies only through pnpm, never by editing `package.json` by hand. Stage explicit paths, never `git add -A` or `git add .`.

## Hands off

- Never write the real `~/.claude/settings.json`. Only a person installs the hooks there, through the app's setup window. To an agent the real `~/.claude` is read-only.
- Never launch Electron, the app or its installer, never touch windows or the keyboard, and never kill a process. The live test in the running app is done by a person.
- Fixtures and tests hold invented data only (see "Invented data in tests" in `CONTRIBUTING.md`), for example a fresh UUID, `p:\proj\alpha`, `pidDomain: 'win32:user'`. Keep the measured shape.

## Language

- Identifiers, commands, comments, docs and commit messages are in English. The GUI texts are in Hungarian.
- In Hungarian text there is never an en or em dash inside a sentence: use a comma or a new sentence.
