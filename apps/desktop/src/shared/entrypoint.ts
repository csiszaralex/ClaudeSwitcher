/**
 * The registry `entrypoint` values the app knows (`~/.claude/sessions/<pid>.json`, read as
 * `SessionView.entrypoint`). Raw strings from Claude Code: only the ones below were measured (see
 * docs/design.md section 3.4), so any other value must stay a raw string everywhere.
 */

/** A session running in the VS Code extension. */
export const VSCODE_ENTRYPOINT = 'claude-vscode'

/** An interactive session started in a terminal. */
export const CLI_ENTRYPOINT = 'cli'

/** A headless `claude -p` run. Its record still says `kind: "interactive"`, so only this value tells it apart. */
export const HEADLESS_ENTRYPOINT = 'sdk-cli'
