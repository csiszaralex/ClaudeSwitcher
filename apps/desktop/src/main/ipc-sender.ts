import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where one renderer page loads from. One source per page: the window loads from it, and the IPC
 * handlers check the sender against it, so the two cannot drift apart.
 * - `dev-server`: `electron-vite dev`, which sets `ELECTRON_RENDERER_URL` (the server's origin);
 * - `file`: the built page, with `loadFile`.
 */
export type RendererLocation = { kind: 'dev-server'; url: string } | { kind: 'file'; path: string }

/**
 * @param rendererDir the built renderer directory (`out/renderer`).
 * @param page the page's HTML file, for example `index.html` (the overlay) or `setup.html`.
 */
export function rendererLocation(devServerUrl: string | undefined, rendererDir: string, page: string): RendererLocation {
  return devServerUrl === undefined
    ? { kind: 'file', path: path.join(rendererDir, page) }
    : { kind: 'dev-server', url: new URL(page, devServerUrl).href }
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/**
 * A `file://` URL útvonala, `undefined`, ha nem alakítható útvonallá. Egy hosztos file URL
 * Windowson UNC útvonal lesz, ami a saját `index.html`-ünkkel úgysem egyezik.
 */
function localPath(url: URL): string | undefined {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

/** Windows útvonal összevetéshez: a fájlrendszer kis- és nagybetűre érzéketlen. */
function comparable(file: string): string {
  return path.win32.normalize(file).toLowerCase()
}

/**
 * True if the IPC call came from our own page: the sending frame's URL is the page `renderer`
 * names. Each page has its own location, so in the build the overlay's handlers refuse the setup
 * page and the other way round.
 *
 * This is needed because a foreign page opened in the overlay (a future bug, or a URL dropped on
 * the window) would get the same preload: it would receive the token and every pending request,
 * and could make Claude Code write a machine-wide permission.
 * - In development the dev server's origin counts (scheme, host, port). This is looser: any page
 *   of the dev server passes, but it only runs on the developer's machine, from our own sources.
 * - In the build exactly our own page (`renderer.path`); the query and the hash do not matter.
 *
 * @param senderUrl `event.senderFrame?.url`; `undefined` if the frame no longer exists.
 */
export function isRendererSender(senderUrl: string | undefined, renderer: RendererLocation): boolean {
  if (senderUrl === undefined) return false
  const sender = parse(senderUrl)
  if (sender === undefined) return false
  if (renderer.kind === 'dev-server') {
    const expected = parse(renderer.url)
    return expected !== undefined && sender.origin !== 'null' && sender.origin === expected.origin
  }
  if (sender.protocol !== 'file:') return false
  const file = localPath(sender)
  return file !== undefined && comparable(file) === comparable(renderer.path)
}
