import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * A főprocessz CommonJS, és ez nem opcionális: az Electron 33 Node 20-at hoz, ahol a
 * CJS `require()` nem tud ES modult betölteni. A saját workspace csomagjaink viszont
 * ESM-only-k, ezért egy externalizált `require("@claudeswitcher/core")` induláskor
 * `ERR_REQUIRE_ESM`-mel hal meg. Ezt valódi Electron főprocesszben mértük le.
 *
 * Megoldás: a workspace csomagokat kizárjuk az externalizálásból, így beépülnek a
 * bundle-be, a tranzitív függőségeikkel (hono, ws, chokidar) együtt — azok nem
 * szerepelnek ennek az appnak a `dependencies`-ében, tehát nem externalizálódnak.
 *
 * Az ESM főprocessz nem járható alternatíva: az Electron 33 ESM-loadere elhasal, ha
 * egy ESM main CJS függőséget tölt be. Ezt is lemértük.
 */
const BUNDLED_WORKSPACE_PACKAGES = ['@claudeswitcher/core', '@claudeswitcher/daemon']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES })],
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] },
})
