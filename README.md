# ClaudeSwitcher

[![verify](https://github.com/csiszaralex/ClaudeSwitcher/actions/workflows/verify.yml/badge.svg)](https://github.com/csiszaralex/ClaudeSwitcher/actions/workflows/verify.yml)

A Windows tray app that shows every running Claude Code session in one list and lets you answer their permission prompts without hunting for the right window.

## Why

If you run many Claude Code sessions at once, most of the time goes into window hunting: which one is waiting for approval, which one is still working, which one finished ten minutes ago. A session that waits for a "yes" just sits there until you happen to look at its window. If you are doing something else meanwhile, watching a film for example, you either keep switching windows or you miss it.

ClaudeSwitcher keeps an eye on the sessions for you. The tray icon changes when a session waits for you, a hotkey brings up a compact list of all sessions, and a pending permission request can be decided right in that list. One key jumps to the session's VS Code window, and to its Claude Code tab.

<!-- TODO(screenshot): overlay with a pending permission decision -->
*Screenshot of the overlay: coming soon.*

## What it does

- **One list of all sessions**, each with its state: waiting for you, working, just finished, idle.
- **Permission decisions from the list.** Allow or deny a tool call (with an optional reason for the session), allow it with a project-level or machine-level rule, let file edits through for the rest of the session, answer a question Claude asks, or reject a plan with feedback.
- **The native prompt stays.** The prompt in VS Code (and on your phone, with Remote Control) stays open the whole time. Whichever answer comes first wins; the app is a second place to decide, not a replacement.
- **Jump to the session.** Brings the session's VS Code window to the front, and then its exact Claude Code tab.

It never starts, stops or prompts a session, and it writes no permission rules itself: when you allow with a rule, Claude Code writes the rule.

## Requirements

- **Windows.** Window focusing uses Win32 calls; no other platform is supported.
- **Claude Code in the VS Code extension.** That is what the app is built for and tested with. Sessions started another way (for example `claude` in a terminal) are not filtered out, and their hooks do reach the app, but the app is not tested with them, and the jump can only bring up a VS Code window that has the session's folder open, never a terminal window.
- **The GUI is in Hungarian.** The labels below are quoted as the app shows them, with an English gloss.

## Install

Download `ClaudeSwitcher-Setup-<version>.exe` from the [latest release](https://github.com/csiszaralex/ClaudeSwitcher/releases/latest) and run it. The installed app brings its own runtime; nothing else is needed.

The installer is not signed, so Windows SmartScreen warns about the downloaded file ("Windows protected your PC"): click "More info", then "Run anyway". To build the installer from source instead, see [`CONTRIBUTING.md`](CONTRIBUTING.md#building-the-installer).

The installer installs for the current user only, without administrator rights, under `%LOCALAPPDATA%\Programs\ClaudeSwitcher`. It asks whether you want a Start menu shortcut (on by default) and a desktop shortcut (off by default), and remembers the answer for the next install. If ClaudeSwitcher is running, the installer asks it to quit through its normal exit path; it never kills it.

### Updating

The installed app looks for a new release at start-up and every 6 hours, and downloads it in the background. When it is ready, a **"Frissítés elérhető"** (update available) popup asks what to do, once the list is closed:

- **"Frissítés most"** (update now): installs the update silently and starts the new version; the settings and the Claude Code integration stay. Requests still waiting are left to the prompts in VS Code.
- **"Most ne"** (not now, also Enter and closing the popup): nothing happens. The update stays in the tray menu as **"Frissítés elérhető (<version>), telepítés"** (update available, install) at the top, where a click installs it the same way, and the popup comes back at the next start (while the checks are on).
- **"Verzió kihagyása"** (skip this version): this version is never offered or downloaded again, not even after a restart. The next newer release is offered as usual.

Nothing is installed without one of those two clicks. Turn the checks off with **"Frissítések keresése"** (check for updates) in the tray or the settings window. The first start after an update that adds a new setting shows the **"Első beállítás"** window once, for that setting.

## First start

On the first start the **"Első beállítás"** (first setup) window opens. It shows the settings you have not confirmed yet; **"Mentés"** (save) confirms everything the window shows.

The window's **"Claude Code integráció"** (Claude Code integration) section is what connects the app to Claude Code. Click **"Telepítés"** (install). This changes your Claude Code user settings, `~/.claude/settings.json` (or `settings.json` under `CLAUDE_CONFIG_DIR`, if you set that variable):

- it adds one HTTP hook for each Claude Code event the app listens to. Each hook posts to the app on `http://127.0.0.1:47821/hooks/...` with an `Authorization: Bearer $CLAUDESWITCHER_TOKEN` header;
- it sets `env.CLAUDESWITCHER_TOKEN`, the app's own token.

It leaves your other hooks and settings alone. Before the first write that changes an existing file it saves a copy next to it, `settings.json.claudeswitcher-backup` (an existing copy is never overwritten). If the file cannot be read or parsed, it writes nothing.

Claude Code sessions started after the install report to the app; sessions already running may need a restart. If the app is not running, Claude Code behaves exactly as without the hooks.

To undo it, open the same window and click **"Eltávolítás"** (remove). It removes only the app's own entries.

## Using it

### The tray

The tray icon changes when a session waits for you, and its tooltip says how many. Clicking the icon opens the list. The right-click menu:

- **"Frissítés elérhető (<version>), telepítés"** (update available, install): at the top, once a new release is downloaded and not skipped; see [Updating](#updating).
- **"Megnyitás"** (open): opens the list.
- **"Gyorsbillentyű: Shift+Alt+Space"** (hotkey): the hotkey in effect, or what is wrong with it if it could not be registered.
- **"Beállítások…"** (settings): the settings window, with the integration section.
- **"Napló megnyitása"** (open the log): opens the log file in your default text editor. The app writes its diagnostic lines, and any uncaught error, to `%APPDATA%\@claudeswitcher\desktop\logs\claudeswitcher.log`. At 1 MiB the file moves to `claudeswitcher.old.log` (replacing the previous one) and a new one starts. The first line of a run names the version. Send the file in when reporting a problem.
- The quick toggles: **"Induljon el bejelentkezéskor"** (start at login), **"Elrejtés az utolsó döntés után"** (hide the list after the last decision), **"Ugrás a pontos Claude-tabra"** (jump to the exact Claude tab), **"Frissítések keresése"** (check for updates, see [Updating](#updating)). All four are on by default.
- **"Kilépés"** (quit).

If the installed integration is out of date, a line **"Integráció elavult, telepítsd újra"** (integration out of date, install again) appears in the menu, with the reason in brackets: **"hiányzó hook"** (a newer version expects a hook the old install lacks) or **"rossz token"** (the token in `settings.json` is not the app's, for example in a `settings.json` brought from another machine; every hook would then be rejected). Clicking the line opens the settings window, where **"Telepítés"** fixes it.

### The list

The default hotkey is **Shift+Alt+Space**; change it in the settings window (**"Gyorsbillentyű"**). The list appears on the display where the mouse is and hides when it loses focus. Each row starts with a marker:

| Marker | Meaning |
|---|---|
| ● | "Válaszra vár": waiting for you |
| ◐ | "Dolgozik": working |
| ✓ | "Épp végzett": just finished |
| ○ | "Tétlen": idle |
| ◆ | the app let go of the request; decide it in VS Code |

Keys: the arrows move the selection, **Enter** jumps to the selected session (so does a double click), **Esc** hides the list.

### Deciding a request

Selecting a waiting session opens its request. What you can do depends on the request:

- **A tool call** (a command, a web fetch, an MCP tool): **"Engedélyez"** (allow, key A), **"Tilt…"** (deny, key D, with an optional reason sent to the session), **"Projekt-szabály…"** (project rule, key P) and **"Gépszintű szabály…"** (machine-wide rule, key G). The rule buttons show Claude Code's suggested rule, which you can edit before allowing; Claude Code then writes it to the project's `.claude/settings.local.json` or to `~/.claude/settings.json`.
- **A file edit:** **"Engedélyez"** (A), **"Tilt…"** (D), and **"Erre a sessionre automatikusan"** (S): accept this session's further edits automatically.
- **A question:** pick the options or type an answer, then **"Válasz elküldése"** (send answer).
- **A plan:** **"Elutasítás visszajelzéssel"** (reject with feedback). A plan cannot be approved from the app; **"Jóváhagyás a VSCode-ban →"** (approve in VS Code) jumps there.

The letter keys do not fire for a short moment after a panel appears, on key repeat, or within a moment after you typed in a text field.

The app holds a request for at most 590 seconds, just under the 600-second timeout its hook is installed with, and then lets go of it. The prompt in VS Code stays and can still be answered there.

## Uninstall

1. Open the settings window from the tray (**"Beállítások…"**) and click **"Eltávolítás"** in the **"Claude Code integráció"** section. The window shows **"Nincs telepítve"** (not installed) once the hooks are gone from `settings.json`.
2. Uninstall ClaudeSwitcher in Windows Settings, under Apps.

The uninstaller also removes the integration on its own, and turns off start at login. If it cannot remove the integration, it says so and goes on; then remove the ClaudeSwitcher entries from `settings.json` by hand. It removes the program files, the shortcuts and the remembered shortcut choices.

It keeps the app's data folder, `%APPDATA%\@claudeswitcher\desktop` (the settings, the token and Electron's cache), and the `settings.json.claudeswitcher-backup` copy. Delete them by hand if you want them gone.

## Development

How to run it from the repository, how it is built, and the rules for changes: [`CONTRIBUTING.md`](CONTRIBUTING.md). The design and the measured Claude Code behaviour it relies on: [`docs/design.md`](docs/design.md).

## License

[MIT](LICENSE).
