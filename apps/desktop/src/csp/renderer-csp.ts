/**
 * A renderer Content-Security-Policyje. Egyetlen forrás: az `index.html` csak egy helyőrzőt
 * tartalmaz, amit a build (electron.vite.config.ts) ennek a kimenetével cserél le.
 *
 * Miért a buildben: a daemon portja egy helyen él (`DAEMON_PORT`), az `index.html` viszont
 * statikus. Így a WebSocket a pontos portra szűkül, és a port nem kerül két helyre.
 */

/** A helyőrző az `index.html` CSP meta tagjének `content` attribútumában. */
export const CSP_PLACEHOLDER = '__CLAUDESWITCHER_CSP__'

export interface CspOptions {
  daemonPort: number
  /**
   * `electron-vite dev`: a dev szerver inline forrásokat szúr be. A @vitejs/plugin-react a React
   * Refresh preamble-t inline modul-scriptként, a Vite a CSS-t `<style>` elemként. A lefordított
   * oldal egyiket sem használja: a script és a CSS külön fájl, inline `style=` attribútum nincs.
   */
  dev: boolean
}

export function rendererCsp({ daemonPort, dev }: CspOptions): string {
  const inline = dev ? " 'unsafe-inline'" : ''
  return [
    "default-src 'self'",
    `script-src 'self'${inline}`,
    `style-src 'self'${inline}`,
    `connect-src 'self' ws://127.0.0.1:${daemonPort}`,
    // Az alábbiak közül a `base-uri` és a `form-action` nem esik vissza a `default-src`-re.
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // A `frame-ancestors` szándékosan hiányzik: meta tagben a böngésző figyelmen kívül hagyja.
  ].join('; ')
}

/**
 * Beírja a CSP-t a helyőrző helyére. Dob, ha a helyőrző nincs meg pontosan egyszer: egy csendben
 * kimaradt csere CSP nélküli (érvénytelen szabályú) oldalt adna.
 */
export function injectCsp(html: string, csp: string): string {
  const parts = html.split(CSP_PLACEHOLDER)
  if (parts.length !== 2) {
    throw new Error(`index.html: expected exactly one ${CSP_PLACEHOLDER}, found ${parts.length - 1}`)
  }
  return parts.join(csp)
}
