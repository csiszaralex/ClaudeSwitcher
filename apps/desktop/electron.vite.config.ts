import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { injectCsp, rendererCsp } from './src/csp/renderer-csp.js'
import { DAEMON_PORT } from './src/main/daemon-port.js'

/**
 * Az app `package.json`-jának `workspace:` függőségei (a saját csomagjaink). Kézi lista helyett a
 * manifestből jön, így egy új workspace csomag nem maradhat ki belőle. Ha egy sem lenne, az hibás
 * manifest: a build hangosan megáll.
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
 * A főprocessz ES modul (`"type": "module"` a `package.json`-ban). A workspace csomagjainkat
 * mégis a bundle-be építjük, a tranzitív függőségeikkel (hono, @hono/node-server, ws) együtt: azok
 * nem szerepelnek ennek az appnak a `dependencies`-ében, tehát nem externalizálódnak. Így futáskor
 * csak a `koffi` és az `electron` jön a `node_modules`-ból.
 *
 * Ez csomagolási döntés, nem betöltési kényszer. Az Electron 33 Node 20-a alatt az volt: a CJS main
 * egy externalizált ESM workspace csomagnál `ERR_REQUIRE_ESM`-mel halt meg. A Node 24.22.1 (az
 * Electron 45-é) az ESM-et és a CJS-ből `require()`-elt ESM-et is betölti, figyelmeztetés nélkül
 * (mérve sima `node`-dal, a 7/2. hullám jelentése). Externalizálva viszont a főprocesszt a pnpm
 * workspace symlinkjei (`node_modules/@claudeswitcher/*` → `packages/*`) és a csomagok `dist`-je
 * táplálná, amit a telepítőnek (a backlog ütemezésében a 8-as tétel) külön be kellene csomagolnia.
 * A bundle-lel ez a gond nem létezik.
 */
const BUNDLED_WORKSPACE_PACKAGES = workspaceDependencies(
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')),
)
if (BUNDLED_WORKSPACE_PACKAGES.length === 0) {
  throw new Error('electron.vite.config.ts: a package.json-ban nincs workspace: függőség')
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
 * The renderer root on its real (resolved) path. On a drive mapped with `subst` (for example
 * `P:` → `D:\P`) Vite resolves the HTML entry to the real path but would keep the root on the mapped
 * one: the relative path between them becomes absolute, and the build fails. Measured 2026-10-30 on
 * a `subst` P: drive. The path is relative to this config file, not to the working directory: knip
 * loads the config from the repo root.
 *
 * The entry pages (`RENDERER_INPUT`) are given on the real path too. electron-vite 6 computes them
 * from the working directory (`electronRendererConfigPresetPlugin`, `findInput`), and Vite 8's
 * Rolldown, started from a working directory under `P:` (`pnpm run build` in `apps/desktop`), would
 * get a name that is absolute relative to the root under `D:`, which it rejects with "neither
 * absolute nor relative paths". Measured 2026-10-30 with Vite 8.3.5; Vite 7 still accepted it.
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
