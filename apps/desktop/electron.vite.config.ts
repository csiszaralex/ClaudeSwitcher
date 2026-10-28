import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin, type swcPlugin } from 'electron-vite'
import { injectCsp, rendererCsp } from './src/csp/renderer-csp.js'
import { DAEMON_PORT } from './src/main/daemon-port.js'

/**
 * A Vite `Plugin` típusa. A `vite` nem közvetlen függősége ennek a csomagnak (az electron-vite hozza),
 * így a pnpm alatt közvetlenül nem importálható; az electron-vite `swcPlugin`-je pont ezt adja vissza.
 */
type Plugin = ReturnType<typeof swcPlugin>

/**
 * A főprocessz CommonJS, és ez nem opcionális: az Electron 33 Node 20-at hoz, ahol a
 * CJS `require()` nem tud ES modult betölteni. A saját workspace csomagjaink viszont
 * ESM-only-k, ezért egy externalizált `require("@claudeswitcher/core")` induláskor
 * `ERR_REQUIRE_ESM`-mel hal meg. Ezt valódi Electron főprocesszben mértük le.
 *
 * Megoldás: a workspace csomagokat kizárjuk az externalizálásból, így beépülnek a
 * bundle-be, a tranzitív függőségeikkel (hono, @hono/node-server, ws) együtt: azok nem
 * szerepelnek ennek az appnak a `dependencies`-ében, tehát nem externalizálódnak.
 *
 * Az ESM főprocessz nem járható alternatíva: az Electron 33 ESM-loadere elhasal, ha
 * egy ESM main CJS függőséget tölt be. Ezt is lemértük.
 */
const BUNDLED_WORKSPACE_PACKAGES = ['@claudeswitcher/core', '@claudeswitcher/daemon']

/**
 * A `ws` opcionális natív gyorsítói. Nincsenek telepítve, és a `ws` egy try/catch-en belül
 * `require`-eli őket, hiány esetén a saját JS változatára vált. Ha a bundler maga oldja fel őket, a
 * Vite helyettesítő modult tesz a helyükre: devben egy modulbetöltéskor dobó modult (ettől nem indult
 * el az `electron-vite dev`), buildben egy üres objektumot. Az utóbbit a `ws` try/catch-e elfogadja,
 * aztán egy kliens legalább 32 bájtos maszkolt keretének kibontásakor `unmask is not a function`
 * hibával elhasal (lemérve a buildelt bundle-ön). Külsőként a `require` a try/catch-en belül marad,
 * így a `ws` mindkét módban a saját JS változatát használja.
 */
const WS_OPTIONAL_NATIVE_DEPS = ['bufferutil', 'utf-8-validate']

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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES })],
    build: { rollupOptions: { external: WS_OPTIONAL_NATIVE_DEPS } },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react(), rendererCspPlugin()] },
})
