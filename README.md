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
- **Claude Code in the VS Code extension.** That is what the app is built for and tested with. Sessions started another way (for example `claude` in a terminal) are not filtered out, and their hooks do reach the app, but the app is mostly tested with the extension. For a terminal session the jump brings up the terminal's window, not the exact tab (see [The list](#the-list)).
- **The GUI is in Hungarian.** The labels below are quoted as the app shows them, with an English gloss.

## Install

Download `ClaudeSwitcher-Setup-<version>.exe` from the [latest release](https://github.com/csiszaralex/ClaudeSwitcher/releases/latest) and run it. The installed app brings its own runtime; nothing else is needed.

The installer is not signed, so Windows SmartScreen warns about the downloaded file ("Windows protected your PC"): click "More info", then "Run anyway". To build the installer from source instead, see [`CONTRIBUTING.md`](CONTRIBUTING.md#building-the-installer).

The installer installs for the current user only, without administrator rights, under `%LOCALAPPDATA%\Programs\ClaudeSwitcher`. It asks whether you want a Start menu shortcut (on by default) and a desktop shortcut (off by default), and remembers the answer for the next install. If ClaudeSwitcher is running, the installer asks it to quit through its normal exit path; it never kills it.

### Updating

The installed app looks for a new release at start-up and every 6 hours, and downloads it in the background. When it is ready, a **"Frissítés elérhető"** (update available) popup asks what to do, once the list is closed:

- **"Frissítés most"** (update now): installs the update silently and starts the new version; the settings and the Claude Code integration stay. Requests still waiting are left to the prompts in VS Code.
- **"Most ne"** (not now, also Enter and closing the popup): nothing happens. The update stays on offer in the tray menu, where **"Frissítés keresése most"** (below) now reads **"Frissítés a/az <version> verzióra"** (update to version <version>; the article, "a" or "az", fits the number): a click installs it the same way, without the popup. After a restart, the start-up check offers it again, in the item and in the popup (while the checks are on). A skipped version that **"Frissítés keresése most"** offered is the exception: the automatic checks leave it, so only another manual check offers it again.
- **"Verzió kihagyása"** (skip this version): the tray item reads **"Frissítés keresése most"** again, and the automatic checks never offer or download this version again, not even after a restart. The next newer release is offered as usual. Only **"Frissítés keresése most"** still offers it.

Nothing is installed without one of those two clicks. Turn the checks off with **"Frissítések keresése"** (check for updates) in the tray or the settings window.

**"Frissítés keresése most"** (check for an update now) in the tray menu checks on request, even with the checks off. While it runs, the item reads **"Frissítés keresése…"** and cannot be clicked. While a downloaded update is on offer, the item is **"Frissítés a/az <version> verzióra"** instead, which installs it. The check ends in one of these, once the list is closed:

- a newer release, even a skipped one: it is downloaded, and the popup above asks what to do. Skipping it again keeps it skipped;
- nothing newer: a box says **"A legfrissebb verzió fut (<version>)."** (the latest version is running);
- the check or the download fails: a box says **"Nem sikerült ellenőrizni a frissítést. Részletek a naplóban."** (could not check for an update, details in the log).

If an automatic check is running at the click, the item waits for its result instead of starting a second check. The first start after an update that adds a new setting shows the **"Első beállítás"** window once, for that setting.

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

The tray icon is a grey dot while nothing waits. It turns orange when a session waits for a yes or a no, and burgundy when a request waits for a choice: a question to answer or a plan to review (burgundy wins when both wait). When a session has finished its turn and you have not opened it since (the green ✓ in the list), the icon turns green, or, while something waits, gets a green ring around the waiting colour. Opening that session from the list (Enter, or a double click) clears its mark and turns its ✓ blue, even when the app finds no window to bring to the front (a session in a terminal the app does not recognise, for example); its next turn clears the mark too. The green lasts exactly as long as a green ✓ is in the list. The app keeps the finishes, and which of them you have seen, in memory only: after it restarts, no session shows a ✓ until it finishes its next turn. When a request the app can still decide has waited longer than 540 seconds, the icon flashes, about once a second, between its normal image and a red dot with a white exclamation mark: the app lets go of the request at 590 seconds (see [Deciding a request](#deciding-a-request)). The flashing stops when no such request is left. The tooltip says how many sessions wait, adds **"választásra vár"** (waits for a choice) for a burgundy icon, and **"N végzett"** (N finished) for the finished sessions not opened yet. Clicking the icon opens the list. The right-click menu:

- **"Megnyitás"** (open): opens the list.
- **"Gyorsbillentyű: Shift+Alt+Space"** (hotkey): the hotkey in effect, or what is wrong with it if it could not be registered.
- **"Beállítások…"** (settings): the settings window, with the integration section.
- **"Napló megnyitása"** (open the log): opens the log file in your default text editor. The app writes its diagnostic lines, and any uncaught error, to `%APPDATA%\@claudeswitcher\desktop\logs\claudeswitcher.log`. At 1 MiB the file moves to `claudeswitcher.old.log` (replacing the previous one) and a new one starts. The first line of a run names the version. Send the file in when reporting a problem.
- **"Frissítés keresése most"** (check for an update now): the installed app only; looks for a new release now, and reads **"Frissítés keresése…"** while it does. Once a new release is downloaded and not skipped, or once this check downloaded a skipped one and you did not skip it again, the item reads **"Frissítés a/az <version> verzióra"** (update to version <version>) instead, and a click installs it. See [Updating](#updating).
- The quick toggles: **"Induljon el bejelentkezéskor"** (start at login), **"Elrejtés az utolsó döntés után"** (hide the list after the last decision), **"Ugrás a pontos Claude-tabra"** (jump to the exact Claude tab), **"Értesítés engedélykérésnél"** (notify on a permission request), **"Értesítés, ha egy session végzett"** (notify when a session finished), **"Frissítések keresése"** (check for updates, see [Updating](#updating)). All are on by default except the notification for a finished session; see [Notifications](#notifications).
- **"Kilépés"** (quit).

If the installed integration is out of date, a line **"Integráció elavult, telepítsd újra"** (integration out of date, install again) appears in the menu, with the reason in brackets: **"hiányzó hook"** (a newer version expects a hook the old install lacks) or **"rossz token"** (the token in `settings.json` is not the app's, for example in a `settings.json` brought from another machine; every hook would then be rejected). Clicking the line opens the settings window, where **"Telepítés"** fixes it.

### Notifications

With the list closed, a Windows toast tells you when a session needs you, so a request does not wait unseen:

- **"Értesítés engedélykérésnél"** (on by default): a toast **"<session> engedélyt kér"** (asks for permission) for every new permission request. The text is the request as the row shows it, with the source label first when the source stands out (for example `claude -p · Bash: pnpm test`). A second request of the same session notifies again.
- **"Értesítés, ha egy session végzett"** (off by default): a toast **"<session> végzett"** (finished) when a session ends its turn, with the start of its last answer. It is off because every turn ends this way, which is noisy with many sessions.

Both can be switched in the tray and in the settings window, and take effect at once. Clicking a toast opens the list with that session selected. Nothing is shown while the list is open, and a request that was already waiting when the app started does not notify (the tray icon shows it). Windows "Do not disturb" (Focus) and full-screen rules can hold a toast back; it then waits in the notification centre. Toasts are meant for the installed app: a repo build may show none, and the log says when toasts are unsupported.

### The list

The default hotkey is **Shift+Alt+Space**; change it in the settings window (**"Gyorsbillentyű"**). The list appears on the display where the mouse is and hides when it loses focus. Each row starts with a marker:

| Marker | Meaning |
|---|---|
| ● (orange) | "Válaszra vár": waiting for you, with a yes or a no |
| ● (burgundy) | "Választásra vár": waiting for a choice, a question or a plan |
| ◐ | "Dolgozik": working |
| ✓ (green) | "Épp végzett": just finished, and you have not opened it since |
| ✓ (blue) | "Végzett, már megnyitottad": finished, and you have opened it since |
| ○ | "Tétlen": idle |
| ◆ | the app let go of the request; decide it at the session's own prompt |

The rows are grouped by their marker, in this order: orange ●, burgundy ●, ◆, green ✓, ◐, blue ✓, ○. In the two ● groups the longest waiting row comes first (a request the app holds is let go after 590 seconds): a row with such a request counts from the oldest one's arrival, any other from when its wait began. When the list opens it selects the longest waiting row of the two groups; if no row waits, it keeps the selected row, or selects the top one. The ◐ rows go by name, so they do not swap places while they work. In the other groups the most recently active row comes first (its last transcript event, its finish or its wait, whichever is latest); rows with the same time go by name.

The status bar at the bottom shows, on the left, where the selected session comes from (the source label described under [Deciding a request](#deciding-a-request)) and its folder, shortened in the middle when it is long (the full path is in its tooltip); on the right, **"ellenőrizve"** (checked) says how long ago the app last scanned the sessions.

Keys: the arrows move the selection, **Enter** jumps to the selected session (so does a double click), **Esc** hides the list.

The jump brings the session's window to the front. For a VS Code extension session that is its VS Code window, and with **"Ugrás a pontos Claude-tabra"** on, its Claude Code tab too. For a terminal session it is the window that shows its terminal: a Windows Terminal window or the VS Code window whose integrated terminal runs it. A classic console window should work too, but has not been measured yet. Only the window comes forward, not the exact tab: Windows Terminal stays on the tab it shows, and VS Code does not open its terminal panel on the session's terminal. When the app finds no terminal window but the session runs under VS Code (a `claude -p` started from an extension session, for example), it jumps to that VS Code window instead. In Git Bash the jump can find nothing: `claude` installed by npm (its sh shim) and a bash started inside bash hide the terminal from the app (see "Mapping to terminal windows" in [`docs/design.md`](docs/design.md)). The native `claude.exe` started from PowerShell or cmd works.

### Deciding a request

Selecting a waiting session opens its request. What you can do depends on the request:

- **A tool call** (a command, a web fetch, an MCP tool): **"Engedélyez"** (allow, key A), **"Tilt…"** (deny, key D, with an optional reason sent to the session), **"Projekt-szabály…"** (project rule, key P) and **"Gépszintű szabály…"** (machine-wide rule, key G). The rule buttons show Claude Code's suggested rule, which you can edit before allowing; Claude Code then writes it to the project's `.claude/settings.local.json` or to `~/.claude/settings.json`.
- **A file edit:** **"Engedélyez"** (A), **"Tilt…"** (D), and **"Erre a sessionre automatikusan"** (S): accept this session's further edits automatically.
- **A question:** pick the options or type an answer, then **"Válasz elküldése"** (send answer).
- **A plan:** **"Elutasítás visszajelzéssel"** (reject with feedback). A plan cannot be approved from the app; **"Jóváhagyás a VSCode-ban →"** (approve in VS Code) jumps there.

Where the app cannot decide (a released request, a plan's approval, a request it does not hold), the texts and the **"Ugrás a VSCode-ba"** (jump to VS Code) button name where the session's own prompt is, by its source: VS Code for an extension session, the terminal for a CLI session and a `claude -p` run (**"Ugrás a terminálhoz"**, **"Jóváhagyás a terminálban →"**, **"A terminálban még dönthetsz."**), and the session itself when the source is unknown or another value (**"Ugrás a sessionhöz"**, **"A sessionben még dönthetsz."**).

Every request shows where it comes from: a source label on the panel (under the request, next to the working folder, and the permission mode when it is not `default`) and, for a source that stands out, on the row too. The label comes from the session's `entrypoint` in Claude Code's session registry: **"VS Code"** (the extension), **"CLI"** (an interactive terminal session), **"claude -p"** (a headless run), any other value as it is, and **"ismeretlen"** (unknown) when the session is not in the registry. Everything except VS Code and CLI stands out: the label is red on the panel, and the row gets a red tag, so a request from a run you did not start yourself is not allowed by habit. Nothing is blocked; you decide as before.

The letter keys do not fire for a short moment after a panel appears, on key repeat, or within a moment after you typed in a text field.

The app holds a request for at most 590 seconds, just under the 600-second timeout its hook is installed with, and then lets go of it. From 540 seconds on, the tray icon flashes to warn you. The session's own prompt (in VS Code or in the terminal) stays and can still be answered there.

## Uninstall

1. Open the settings window from the tray (**"Beállítások…"**) and click **"Eltávolítás"** in the **"Claude Code integráció"** section. The window shows **"Nincs telepítve"** (not installed) once the hooks are gone from `settings.json`.
2. Uninstall ClaudeSwitcher in Windows Settings, under Apps.

The uninstaller also removes the integration on its own, and turns off start at login. If it cannot remove the integration, it says so and goes on; then remove the ClaudeSwitcher entries from `settings.json` by hand. It removes the program files, the shortcuts and the remembered shortcut choices.

It keeps the app's data folder, `%APPDATA%\@claudeswitcher\desktop` (the settings, the token and Electron's cache), and the `settings.json.claudeswitcher-backup` copy. Delete them by hand if you want them gone.

## Development

How to run it from the repository, how it is built, and the rules for changes: [`CONTRIBUTING.md`](CONTRIBUTING.md). The design and the measured Claude Code behaviour it relies on: [`docs/design.md`](docs/design.md).

## License

[MIT](LICENSE).
