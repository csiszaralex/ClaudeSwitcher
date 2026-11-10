/**
 * The daemon's fixed port. Not ephemeral, because the installed hooks get this URL in
 * settings.json: a port that changed on every restart would make them dead after each restart.
 *
 * In a separate module without imports, because the build config (electron.vite.config.ts) takes it
 * from here too, for the renderer CSP. `claude-integration.ts` imports the core. electron-vite
 * compiles the config to CommonJS and leaves the dependencies external, so it would load the core's
 * ESM-only package with `require` (see `BUNDLED_WORKSPACE_PACKAGES`, the same problem in the main
 * process).
 */
export const DAEMON_PORT = 47821
