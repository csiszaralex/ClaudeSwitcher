import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DAEMON_PORT } from '../main/daemon-port.js'
import { CSP_PLACEHOLDER, injectCsp, rendererCsp } from './renderer-csp.js'

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/)
      return [name, sources.join(' ')]
    }),
  )
}

describe('rendererCsp', () => {
  const built = directives(rendererCsp({ daemonPort: DAEMON_PORT, dev: false }))

  it('pins the websocket to the exact daemon port', () => {
    expect(built.get('connect-src')).toBe(`'self' ws://127.0.0.1:${DAEMON_PORT}`)
  })

  it('closes the directives that do not fall back to default-src, and plugins', () => {
    expect(built.get('object-src')).toBe("'none'")
    expect(built.get('base-uri')).toBe("'none'")
    expect(built.get('form-action')).toBe("'none'")
  })

  it('leaves out frame-ancestors, which a meta-delivered policy ignores', () => {
    expect(built.has('frame-ancestors')).toBe(false)
  })

  it('allows no inline script or style in the built page', () => {
    expect(built.get('default-src')).toBe("'self'")
    expect(built.get('script-src')).toBe("'self'")
    expect(built.get('style-src')).toBe("'self'")
  })

  it('allows the inline sources the dev server injects only in dev', () => {
    // A @vitejs/plugin-react a React Refresh preamble-t inline modul-scriptként szúrja be, a Vite
    // dev szerver pedig a CSS-t <style> elemként.
    const devPolicy = directives(rendererCsp({ daemonPort: DAEMON_PORT, dev: true }))
    expect(devPolicy.get('script-src')).toBe("'self' 'unsafe-inline'")
    expect(devPolicy.get('style-src')).toBe("'self' 'unsafe-inline'")
    expect(devPolicy.get('connect-src')).toBe(`'self' ws://127.0.0.1:${DAEMON_PORT}`)
    expect(devPolicy.get('object-src')).toBe("'none'")
  })
})

describe('injectCsp', () => {
  it('replaces the one placeholder', () => {
    expect(injectCsp(`<meta content="${CSP_PLACEHOLDER}">`, "default-src 'self'")).toBe(
      `<meta content="default-src 'self'">`,
    )
  })

  it('throws when the placeholder is missing or doubled, instead of shipping a page without a policy', () => {
    expect(() => injectCsp('<meta content="x">', 'p')).toThrow()
    expect(() => injectCsp(`${CSP_PLACEHOLDER}${CSP_PLACEHOLDER}`, 'p')).toThrow()
  })

  it('finds exactly one placeholder in the real index.html, inside the CSP meta', () => {
    const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8')
    expect(html.split(CSP_PLACEHOLDER)).toHaveLength(2)
    expect(html).toMatch(new RegExp(`http-equiv="Content-Security-Policy"\\s+content="${CSP_PLACEHOLDER}"`))
  })
})
