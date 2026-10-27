import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Honnan tölti az overlay a rendererét. Egyetlen forrás: a `createOverlay` ebből tölt, és az
 * IPC-kezelők ehhez mérik a küldőt, így a kettő nem csúszhat szét.
 * - `dev-server`: `electron-vite dev`, ami az `ELECTRON_RENDERER_URL`-t beállítja;
 * - `file`: a lefordított `index.html`, `loadFile`-lal.
 */
export type RendererLocation = { kind: 'dev-server'; url: string } | { kind: 'file'; path: string }

export function rendererLocation(devServerUrl: string | undefined, indexFile: string): RendererLocation {
  return devServerUrl === undefined ? { kind: 'file', path: indexFile } : { kind: 'dev-server', url: devServerUrl }
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
 * Igaz, ha az IPC-hívás a saját rendererünktől jött: a küldő keret URL-je a betöltött renderer.
 *
 * Erre azért van szükség, mert egy az overlayben megnyílt idegen oldal (egy jövőbeli hiba, vagy
 * az ablakra húzott URL) ugyanazt a preloadot kapná: megkapná a tokent és minden függő kérést, és
 * egy gépszintű engedélyt íratna a Claude Code-dal.
 * - Fejlesztés közben a dev szerver origója számít (séma, hoszt, port). Ez lazább: a dev szerver
 *   bármelyik oldala átmegy, de az csak a fejlesztői gépen fut, a saját forrásainkból.
 * - Élesben pontosan a saját `index.html`-ünk; a query és a hash nem számít.
 *
 * @param senderUrl `event.senderFrame?.url`; `undefined`, ha a keret már nem létezik.
 */
export function isOverlaySender(senderUrl: string | undefined, renderer: RendererLocation): boolean {
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
