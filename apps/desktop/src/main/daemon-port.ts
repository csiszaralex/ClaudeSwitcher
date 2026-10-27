/**
 * A daemon rögzített portja. Nem ideiglenes, mert a telepített hookok és a statusLine ezt
 * az URL-t kapják a settings.json-ban: egy újraindításonként változó port minden
 * újraindítás után halottá tenné őket.
 *
 * Külön modulban, import nélkül, mert a build-konfig (electron.vite.config.ts) is ebből veszi a
 * renderer CSP-jéhez. A `setup.ts` a core-t importálja. Az electron-vite a konfigot CommonJS-re
 * fordítja, a függőségeket pedig külsőként hagyja, így a core ESM-only csomagját `require`-rel
 * töltené be (lásd `BUNDLED_WORKSPACE_PACKAGES`, ugyanez a gond a főprocesszben).
 */
export const DAEMON_PORT = 47821
