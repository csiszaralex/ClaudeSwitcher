import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isRendererSender, rendererLocation } from './ipc-sender.js'

const RENDERER_DIR = 'P:\\08_Apps\\ClaudeSwitcher\\apps\\desktop\\out\\renderer'
const INDEX = `${RENDERER_DIR}\\index.html`
const SETUP = `${RENDERER_DIR}\\setup.html`
const production = rendererLocation(undefined, RENDERER_DIR, 'index.html')
const dev = rendererLocation('http://localhost:5173', RENDERER_DIR, 'index.html')

describe('rendererLocation', () => {
  it('uses the dev server when electron-vite sets its URL, and the built page otherwise', () => {
    expect(dev).toEqual({ kind: 'dev-server', url: 'http://localhost:5173/index.html' })
    expect(production).toEqual({ kind: 'file', path: INDEX })
  })

  it('names the setup page on the dev server and in the build', () => {
    expect(rendererLocation('http://localhost:5173', RENDERER_DIR, 'setup.html')).toEqual({
      kind: 'dev-server',
      url: 'http://localhost:5173/setup.html',
    })
    expect(rendererLocation(undefined, RENDERER_DIR, 'setup.html')).toEqual({ kind: 'file', path: SETUP })
  })
})

describe('isRendererSender between our two pages', () => {
  const setup = rendererLocation(undefined, RENDERER_DIR, 'setup.html')

  it('keeps the overlay and the setup page apart in the build', () => {
    expect(isRendererSender(pathToFileURL(SETUP).href, production)).toBe(false)
    expect(isRendererSender(pathToFileURL(INDEX).href, setup)).toBe(false)
    expect(isRendererSender(pathToFileURL(SETUP).href, setup)).toBe(true)
  })

  it('checks only the origin on the dev server, so there the two pages pass each other', () => {
    const devSetup = rendererLocation('http://localhost:5173', RENDERER_DIR, 'setup.html')
    expect(isRendererSender('http://localhost:5173/index.html', devSetup)).toBe(true)
  })
})

describe('isRendererSender', () => {
  it('accepts our built index loaded from file://', () => {
    expect(isRendererSender(pathToFileURL(INDEX).href, production)).toBe(true)
  })

  it('ignores the drive letter case, percent encoding, query and hash of our own index', () => {
    // A Windows útvonal kis- és nagybetűre érzéketlen; a Chromium a szóközt %20-ként adja.
    const spaced = rendererLocation(undefined, 'C:\\My Apps\\out\\renderer', 'index.html')
    expect(isRendererSender('file:///c:/my%20apps/out/renderer/index.html#x', spaced)).toBe(true)
    expect(isRendererSender(`${pathToFileURL(INDEX).href}?a=1`, production)).toBe(true)
  })

  it('refuses another local file, even next to our index', () => {
    expect(isRendererSender(pathToFileURL(INDEX.replace('index.html', 'evil.html')).href, production)).toBe(false)
    expect(isRendererSender('file:///C:/Users/user/Downloads/index.html', production)).toBe(false)
  })

  it('refuses a remote page, a UNC file and a missing frame in production', () => {
    expect(isRendererSender('https://example.com/', production)).toBe(false)
    expect(isRendererSender('file://server/share/out/renderer/index.html', production)).toBe(false)
    expect(isRendererSender(undefined, production)).toBe(false)
    expect(isRendererSender('', production)).toBe(false)
    expect(isRendererSender('not a url', production)).toBe(false)
  })

  it('accepts any page of the dev server origin in dev', () => {
    expect(isRendererSender('http://localhost:5173/', dev)).toBe(true)
    expect(isRendererSender('http://localhost:5173/index.html?t=1', dev)).toBe(true)
  })

  it('refuses another origin in dev, including another port and our own file index', () => {
    expect(isRendererSender('http://localhost:5174/', dev)).toBe(false)
    expect(isRendererSender('http://127.0.0.1:5173/', dev)).toBe(false)
    expect(isRendererSender('https://localhost:5173/', dev)).toBe(false)
    expect(isRendererSender(pathToFileURL(INDEX).href, dev)).toBe(false)
    expect(isRendererSender(undefined, dev)).toBe(false)
  })
})
