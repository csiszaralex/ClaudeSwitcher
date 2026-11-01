# ClaudeSwitcher: installer, autostart, first-run setup (wave 8, part 1)

Status: design, approved for planning on 2026-10-31.
This is the first document written in English. The project switches all code comments and docs to English in part 2 of wave 8 (the GUI stays Hungarian).

## Why

Today the app runs from the repo: `pnpm --filter @claudeswitcher/desktop build` + `start`. That costs Alex in two ways:
- **Development and use collide.** A running app locks `node_modules` and `out/`, so an install or a build in the repo breaks or is blocked. This happened in wave 7/3.
- **There is no way to have it simply be there.** It does not start at login, has no shortcut, and nothing upgrades it.

## Wave 8 as a whole (agreed order; only part 1 is designed here)

1. **Installer, autostart, first-run setup.** This document.
2. **Clean-up for publication.** Readable SOLID code, a good `README.md`, everything except the GUI in English. GUI i18n is a later, separate item.
3. **History rewrite before going public.** Old commits still contain real local data (a dead IDE token, session ids, folder names, the user name). Replace it with invented values in every commit, and remap the commit hashes the docs cite.
4. **Public GitHub repo, then push.**
5. **Releases and the in-app updater.**
   - A GitHub Action computes the version from Conventional Commits (`fix` → patch, `feat` → minor) on merge to main, and publishes a GitHub Release with the installer. Nx release is the preferred tool.
   - `commitlint` in a `commit-msg` hook enforces `type(scope): short description` with exactly one scope from a fixed list.
   - The app checks the latest Release at start. If it is newer, it offers three choices:
     - **Igen:** download and run the new installer.
     - **Nem:** continue, and offer again at the next start.
     - **Verzió kihagyása:** never offer this version again; offer the next one.

Part 1 must not block part 5: the installer must be able to install over a running older version (see "Upgrade-in-place").

## Goals (part 1)

1. **A Windows installer.**
   - It installs per user, without admin rights, under `%LOCALAPPDATA%\Programs`.
   - It provides an uninstaller and the standard Add/Remove Programs entry.
2. **Installer options, both as checkboxes on an installer page:**
   - Start menu shortcut, default on.
   - Desktop shortcut, default off.

   The installer creates them, so its uninstaller removes them.
3. **Autostart at login** through Electron's login item (`app.setLoginItemSettings`). It is not a Windows service.
4. **A first-run setup window ("Első beállítás")** in the app. It covers:
   - autostart;
   - the existing overlay settings `hideAfterLastDecision` and `jumpToTab`;
   - the hotkey;
   - a button that installs the Claude Code integration, using the existing `setup.ts` path.
5. **The same window is reachable later** from the tray menu as "Beállítások…".
6. **The installed app runs from its install location, not from the repo.**
   - Resources (tray icons) resolve correctly when packaged. Today `tray.ts` uses `../../resources`, which only works from the repo; this is a deferred backlog item.
7. **Only one ClaudeSwitcher runs at a time**, installed or built from the repo.

## The settings rule (Alex's, applies from now on)

**Every user setting lives in the first-run setup window.** A new setting is only complete when it appears there.

- **The window asks only for what the user has never set.**
  - On the very first start, that is everything.
  - After an update that adds a setting, the window opens by itself with only the new setting(s). A "Minden beállítás" link shows all of them.
  - When nothing is unset, the window does not open by itself.
- **This needs "the user chose this value" to be distinguishable from "nobody asked yet".** Today `config.ts` `loadConfig` fills missing keys with defaults silently, and the first start even writes all defaults into `config.json`. So the distinction is lost.
  - Part 1 must record which settings the user has confirmed, for example a list of confirmed keys in `config.json`.
  - The exact form is the builder's call, with one constraint: an existing `config.json` written by today's app must still load. Its settings count as unconfirmed, so Alex is asked once.
- **One fact in one place.** There is a single list of settings, each with its key, default, and how the window presents it. `config.ts`, the window and the tray read from it. No second list.

Autostart is a setting like the others: stored, confirmed, shown in the window. Its source of truth is the OS login item. The window and the tray show the real state read back from `app.getLoginItemSettings`. The config records only that the user has answered the question.

## One instance, and a second build starting

- **The same build started again** (for example the installed app twice): unchanged from today. The second instance quits silently, and the first shows the overlay (`second-instance`).
- **A different build** (the installed app runs, and Alex starts `dev` or `start` from the repo, or the other way round): a dialog appears:
  > Már fut egy ClaudeSwitcher (telepített, 1.2.0). Bezárjam, és ez induljon?

  The buttons are **[Bezárás és indítás]** and **[Mégse]**.
  - **Mégse:** the new build quits, and the old one keeps running.
  - **Bezárás és indítás:** the old one quits cleanly (its daemon releases port 47821), and the new one takes over.
- **"Different build"** means a different executable path. The version is only for the text.
- **Known risk, to be measured, not guessed:** Electron's single-instance lock only lets the second instance send data to the first, and the first cannot answer. So either:
  - the first instance shows the dialog and quits on "yes", while the second waits for the lock and retries; or
  - another mechanism is used.

  The builder measures which one is reliable on this machine and documents it. The port must be free before the new daemon starts.

## Data and identity

- **The installed app and the repo builds share one `userData` directory.** Today it is `%APPDATA%\@claudeswitcher\desktop`, derived from the package name. That directory holds `config.json` and the token.
  - Sharing it keeps Alex's settings.
  - It also keeps the token that the already installed Claude Code hooks send, so the hooks keep working without reinstalling the integration.
  - Packaging must not silently move it, for example through a `productName`. Measure the path in a packaged build before relying on it.
- **The single-instance lock is tied to `userData`.** The shared directory is also what makes installed and repo builds see each other's lock. Verify this.
- **Port 47821 stays fixed.** The installed hooks point at it.

## Upgrade-in-place

The installer must handle a running ClaudeSwitcher:
1. close it;
2. install;
3. start the new version.

Settings and the token survive, because they live in `userData` and not in the install directory. A silent reinstall (as part 5's updater will run it) does not show the first-run window unless the new version added a setting.

## Constraints

- **Strictness stays as is:** `CLAUDE.md`, `pnpm verify`, no casts, no `eslint-disable`.
- **No synchronous child processes** in non-test code.
- **The agent never runs the real installer, never writes the real `~/.claude/settings.json`, and never launches Electron.** Alex runs the live test. Anything that needs a running app is in Alex's test protocol.
- **Tooling:**
  - newest stable versions of the packager and its dependencies, added through pnpm;
  - pnpm 12 `allowBuilds` kept working;
  - the build must work on the `subst` drive `P:` (see `CLAUDE.md`, `RENDERER_ROOT`).
- **The renderer value-import rule stays** (`@claudeswitcher/core/browser` only). If the setup window is a renderer page, the same CSP and IPC sender checks apply as for the overlay.
- **Code signing:** none for now. SmartScreen will warn on first run, which is accepted for personal use.

## Details settled after the builder check

- **Autostart in repo builds.** `setLoginItemSettings` registers the running executable, and in a repo build that is `node_modules\electron\dist\electron.exe`. So repo builds never register autostart.
  - In a repo build, the window and the tray show autostart read-only, with the note "csak a telepített appban".
  - Answering the question in a repo build does not count as confirming it: it stays unconfirmed until the installed app asks it.
- **What confirms a setting.**
  - The window has an explicit **[Mentés]** button. It confirms every setting the window showed, pre-ticked defaults included.
  - Closing the window with X confirms nothing. The current values stay in effect, and the window opens again at the next start, like "Nem" in the updater.
  - Changing a setting from the tray confirms that setting.
  - The integration install is an action, not a setting. The window shows its state and the button, but a missing integration never makes the window open by itself.
- **The tray menu.**
  - It keeps quick toggles for `hideAfterLastDecision`, `jumpToTab` and autostart. They read from and write to the same settings list, and stay in sync with an open window.
  - It gains "Beállítások…".
  - It loses "edit config.json", which the hotkey capture field replaces.
- **"Different build"** is the pair of executable path and app path (`process.execPath` + `app.getAppPath()`). So `dev` versus `start` from the repo also counts as different and gets the dialog. The same pair again keeps today's silent hand-over.
- **Closing a running app cleanly.** The installer, the uninstaller and the different-build hand-over all use the same path: they ask the running app to quit through its normal `before-quit` sequence, never a force kill.
  - The normal sequence lets the daemon release held permission requests (`STOP_TIMEOUT_MS`), so Claude Code falls back to its native prompt.
  - The intended mechanism is the app's own executable started with a quit argument, delivered through `second-instance`.
  - The builder measures that NSIS can do this, and that it waits until port 47821 is free.
- **Uninstall:**
  - **Removes:** the program files, the shortcuts, and the autostart entry. The app removes the entry itself: the uninstaller asks the installed exe to unregister it and quit.
  - **Removes the Claude Code integration** by starting the installed exe with a remove argument. The app runs the existing `setup.ts` removal and exits, so `setup.ts` stays the only writer of `settings.json`. If that fails, the uninstaller says so and continues.
  - **Keeps** `userData` (config and token): repo builds share it.
- **Shortcut choices on reinstall and upgrade.** The installer stores the two shortcut choices (in HKCU) and reuses them on a later install. A silent upgrade does not recreate a shortcut Alex removed, or drop one he chose. They are install options, not app settings, so they are not in the first-run window.
- **Language of new code.** New code, comments and docs are written in English from part 1 on. Existing Hungarian comments are translated in part 2. `CLAUDE.md`'s language line changes accordingly. GUI strings stay Hungarian.

## Decided by Claude (not asked)

- **Packager:** electron-builder with the NSIS target, `oneClick: false`, so the installer has a page for the two shortcut checkboxes. Squirrel (Electron Forge) was rejected: no install location choice, and it needs its own update server.
- **App icon:** derived from the current tray icon.
- **Autostart default:** on, pre-ticked in the first-run window.
- **Upgrade-in-place:** close, install, restart.
- **The hotkey in the first-run window:** a capture field ("press the combination"), validated with the existing `hotkey.ts` logic. This replaces "open `config.json` in an editor" in the tray menu.

## Left to the builder

- How the confirmed-settings record looks in `config.json`, within the compatibility constraint above.
- Whether the setup window is a second `BrowserWindow` with its own renderer entry or a view in the overlay window. Either is fine if the CSP, sender checks and value-import rules hold.
- The dialog mechanism for "a different build is running", by measurement, within the clean-quit rule above.
- Where the packaged resources live, and how `tray.ts` resolves them in both modes.
- Script names, for example `pnpm --filter @claudeswitcher/desktop dist` for building the installer.

## Non-goals

- The GitHub repo, Releases, the version bump, and the in-app updater. They are part 5. Part 1 only keeps upgrade-in-place possible.
- Code signing, auto-update without asking, a Windows service, and macOS or Linux packages.
- Moving or migrating `userData`.

## Anti-goals (would make this a failure even if it technically works)

- The installed app uses a different `userData` than the repo builds. That would bring a new token, break the installed hooks, and lose Alex's settings.
- The installer or an update overwrites a setting Alex changed.
- Two ClaudeSwitchers run at once, or the second build fails with a raw port error instead of the dialog.
- A setting that exists only in `config.json` or only in the tray, outside the first-run window.
- The installer writes Claude Code's `settings.json` itself. The integration has exactly one writer, `setup.ts`, with its backup and conflict handling.

## Done when

**Alex's live test passes:**
1. a fresh install with each shortcut option;
2. the first-run window on first start;
3. autostart after a log-off and log-on;
4. "Beállítások…" from the tray;
5. a repo `start` while the installed app runs, showing the dialog, both answers;
6. reinstalling over a running installed app, with a permission request pending:
   - the request falls back to the native prompt;
   - the settings and the shortcut choices are kept;
7. uninstall:
   - the autostart entry and the shortcuts are gone;
   - the integration is removed from `~/.claude/settings.json`;
   - `userData` is still there.

**Also:**
- `pnpm verify` is green.
- The README describes installing, building the installer, and the shared `userData`.
