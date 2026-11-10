/**
 * The renderer's Content-Security-Policy. The single source: the pages (`index.html`, `setup.html`)
 * hold only a placeholder, which the build (electron.vite.config.ts `rendererCspPlugin`) replaces
 * with this module's output.
 *
 * Why in the build: the daemon port lives in one place (`DAEMON_PORT`), but the HTML pages are
 * static. So the WebSocket is narrowed to the exact port, and the port is not kept in two places.
 */

/** The placeholder in the `content` attribute of each page's CSP meta tag. */
export const CSP_PLACEHOLDER = '__CLAUDESWITCHER_CSP__'

export interface CspOptions {
  daemonPort: number
  /**
   * `electron-vite dev`: the dev server injects inline sources. @vitejs/plugin-react injects the
   * React Refresh preamble as an inline module script, Vite the CSS as a `<style>` element. The
   * built page uses neither: the script and the CSS are separate files, and there is no inline
   * `style=` attribute.
   */
  dev: boolean
}

export function rendererCsp({ daemonPort, dev }: CspOptions): string {
  const inline = dev ? " 'unsafe-inline'" : ''
  return [
    "default-src 'self'",
    `script-src 'self'${inline}`,
    `style-src 'self'${inline}`,
    // The host is core `DAEMON_HOST`; this module cannot import core, a test ties the two.
    `connect-src 'self' ws://127.0.0.1:${daemonPort}`,
    // Of the following, `base-uri` and `form-action` do not fall back to `default-src`.
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // `frame-ancestors` is left out on purpose: the browser ignores it in a meta tag.
  ].join('; ')
}

/**
 * Writes the CSP in place of the placeholder. Throws if the placeholder is not there exactly once:
 * a silently skipped replacement would give a page without a CSP (with an invalid policy).
 */
export function injectCsp(html: string, csp: string): string {
  const parts = html.split(CSP_PLACEHOLDER)
  if (parts.length !== 2) {
    throw new Error(`index.html: expected exactly one ${CSP_PLACEHOLDER}, found ${parts.length - 1}`)
  }
  return parts.join(csp)
}
