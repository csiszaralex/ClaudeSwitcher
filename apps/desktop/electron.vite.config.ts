import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { injectCsp, rendererCsp } from './src/csp/renderer-csp.js'
import { DAEMON_PORT } from './src/main/daemon-port.js'

/**
 * The `workspace:` dependencies of the app's `package.json` (our own packages). They come from the
 * manifest instead of a hand-kept list, so a new workspace package cannot be left out. If there
 * were none, the manifest is wrong: the build stops loudly.
 */
function workspaceDependencies(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null || !('dependencies' in manifest)) return []
  const { dependencies } = manifest
  if (typeof dependencies !== 'object' || dependencies === null) return []
  return Object.entries(dependencies)
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:'))
    .map(([name]) => name)
}

/**
 * The main process is an ES module (`"type": "module"` in `package.json`). Our workspace packages
 * are still built into the bundle, together with their transitive dependencies (hono,
 * @hono/node-server, ws): those are not in this app's `dependencies`, so they are not externalized.
 * So at runtime only `koffi` and `electron` come from `node_modules`.
 *
 * This is a packaging decision, not a loading constraint. Under Electron 33's Node 20 it was one: the
 * CJS main died with `ERR_REQUIRE_ESM` on an externalized ESM workspace package. Node 24.22.1
 * (Electron 45's) loads ESM, and ESM `require()`d from CJS, without a warning (measured with plain
 * `node`). Externalized, though, the main process would be fed by the pnpm workspace symlinks
 * (`node_modules/@claudeswitcher/*` → `packages/*`) and the packages' `dist`, which the installer
 * would have to package separately. With the bundle this problem does not exist.
 */
const BUNDLED_WORKSPACE_PACKAGES = workspaceDependencies(
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')),
)
if (BUNDLED_WORKSPACE_PACKAGES.length === 0) {
  throw new Error('electron.vite.config.ts: package.json has no workspace: dependency')
}

/**
 * Writes the renderer CSP into the placeholder of every page (`index.html`, `setup.html`; see
 * `rendererCsp`). The dev server (`ctx.server`) gets the looser, development-only policy, the build
 * the strict one.
 */
function rendererCspPlugin(): Plugin {
  return {
    name: 'claudeswitcher-renderer-csp',
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => injectCsp(html, rendererCsp({ daemonPort: DAEMON_PORT, dev: ctx.server !== undefined })),
    },
  }
}

/**
 * The renderer root on its real (resolved) path. On a drive mapped with `subst` and its real path,
 * Vite resolves the HTML entry to the real path but would keep the root on the mapped one: the
 * relative path between them becomes absolute, and the build fails. Measured live on 2026-10-30.
 * The path is relative to this config file, not to the working directory: knip loads the config
 * from the repo root.
 *
 * The entry pages (`RENDERER_INPUT`) are given on the real path too. electron-vite 6 computes them
 * from the working directory (`electronRendererConfigPresetPlugin`, `findInput`), and Vite 8's
 * Rolldown, started from a working directory on the mapped drive (`pnpm run build` in
 * `apps/desktop`), would get a name that is absolute relative to the root on the real path, which it
 * rejects with "neither absolute nor relative paths". Measured live on 2026-10-30 with Vite 8.3.5;
 * Vite 7 still accepted it.
 */
const RENDERER_ROOT = realpathSync.native(fileURLToPath(new URL('./src/renderer', import.meta.url)))
/** The two pages: the overlay (`index`) and the setup window (`setup`). */
const RENDERER_INPUT = {
  index: path.join(RENDERER_ROOT, 'index.html'),
  setup: path.join(RENDERER_ROOT, 'setup.html'),
}

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: BUNDLED_WORKSPACE_PACKAGES } },
  },
  // The preload stays CommonJS: a sandboxed preload cannot be an ES module (Electron
  // `docs/tutorial/esm.md`). Because of `"type": "module"` electron-vite would emit ESM, so the format
  // is spelled out; the output is `out/preload/index.cjs` and `out/preload/setup.cjs`. Dependencies
  // are externalized by default (`build.externalizeDeps`).
  // Two entries, one per window: the setup window's preload exposes only `SetupApi`, never the token.
  preload: {
    build: {
      rolldownOptions: {
        input: { index: 'src/preload/index.ts', setup: 'src/preload/setup.ts' },
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: RENDERER_ROOT,
    build: { rolldownOptions: { input: RENDERER_INPUT } },
    plugins: [react(), rendererCspPlugin()],
  },
})
