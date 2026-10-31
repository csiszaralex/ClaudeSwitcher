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
 * A renderer CSP-je az `index.html` helyőrzőjébe (lásd `rendererCsp`). A dev szerveren (`ctx.server`)
 * a lazább, csak fejlesztői változat megy ki, a buildben a szigorú.
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
 * A renderer gyökere a valódi (feloldott) útvonalon. Egy `subst`-tal leképezett meghajtón (pl. `P:` → `D:\P`)
 * a Vite az `index.html`-t a valódi útvonalra oldja fel, a gyökeret viszont a leképezettre hagyná: a
 * kettő közti relatív út abszolút lesz, és a build elbukik. Mérve 2026-10-30, egy `subst` P: meghajtón.
 * Az útvonal a config fájlhoz képest számít, nem a munkakönyvtárhoz: a knip a repó gyökeréből tölti be.
 *
 * A belépő HTML-t (`RENDERER_INPUT`) is a valódi útvonalon adjuk meg. Az electron-vite 6 a munkakönyvtárból
 * számolja (`electronRendererConfigPresetPlugin`, `findInput`), és a Vite 8 Rolldownja egy `P:` alatti
 * munkakönyvtárból indítva (`pnpm run build` az `apps/desktop`-ban) a `D:` alatti gyökérhez képest abszolút
 * nevet kapna, amit „neither absolute nor relative paths” hibával elutasít. Mérve 2026-10-30, Vite 8.3.5-tel;
 * a Vite 7 ezt még elfogadta.
 */
const RENDERER_ROOT = realpathSync.native(fileURLToPath(new URL('./src/renderer', import.meta.url)))
const RENDERER_INPUT = path.join(RENDERER_ROOT, 'index.html')

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: BUNDLED_WORKSPACE_PACKAGES } },
  },
  // A preload CommonJS marad: sandboxolt preload nem lehet ES modul (Electron `docs/tutorial/esm.md`).
  // A `"type": "module"` miatt az electron-vite ESM-et adna, ezért a formátum ki van írva; a kimenet
  // így `out/preload/index.cjs`. A függőségeket alapból (`build.externalizeDeps`) externalizálja.
  preload: { build: { rolldownOptions: { output: { format: 'cjs' } } } },
  renderer: {
    root: RENDERER_ROOT,
    build: { rolldownOptions: { input: RENDERER_INPUT } },
    plugins: [react(), rendererCspPlugin()],
  },
})
