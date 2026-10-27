import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isOverlaySender, rendererLocation } from './ipc-sender.js'

const INDEX = 'P:\\08_Apps\\ClaudeSwitcher\\apps\\desktop\\out\\renderer\\index.html'
const production = rendererLocation(undefined, INDEX)
const dev = rendererLocation('http://localhost:5173', INDEX)

describe('rendererLocation', () => {
  it('uses the dev server when electron-vite sets its URL, and the built index otherwise', () => {
    expect(dev).toEqual({ kind: 'dev-server', url: 'http://localhost:5173' })
    expect(production).toEqual({ kind: 'file', path: INDEX })
  })
})

describe('isOverlaySender', () => {
  it('accepts our built index loaded from file://', () => {
    expect(isOverlaySender(pathToFileURL(INDEX).href, production)).toBe(true)
  })

  it('ignores the drive letter case, percent encoding, query and hash of our own index', () => {
    // A Windows útvonal kis- és nagybetűre érzéketlen; a Chromium a szóközt %20-ként adja.
    const spaced = 'C:\\My Apps\\out\\renderer\\index.html'
    expect(isOverlaySender('file:///c:/my%20apps/out/renderer/index.html#x', rendererLocation(undefined, spaced))).toBe(
      true,
    )
    expect(isOverlaySender(`${pathToFileURL(INDEX).href}?a=1`, production)).toBe(true)
  })

  it('refuses another local file, even next to our index', () => {
    expect(isOverlaySender(pathToFileURL(INDEX.replace('index.html', 'evil.html')).href, production)).toBe(false)
    expect(isOverlaySender('file:///C:/Users/user/Downloads/index.html', production)).toBe(false)
  })

  it('refuses a remote page, a UNC file and a missing frame in production', () => {
    expect(isOverlaySender('https://example.com/', production)).toBe(false)
    expect(isOverlaySender('file://server/share/out/renderer/index.html', production)).toBe(false)
    expect(isOverlaySender(undefined, production)).toBe(false)
    expect(isOverlaySender('', production)).toBe(false)
    expect(isOverlaySender('not a url', production)).toBe(false)
  })

  it('accepts any page of the dev server origin in dev', () => {
    expect(isOverlaySender('http://localhost:5173/', dev)).toBe(true)
    expect(isOverlaySender('http://localhost:5173/index.html?t=1', dev)).toBe(true)
  })

  it('refuses another origin in dev, including another port and our own file index', () => {
    expect(isOverlaySender('http://localhost:5174/', dev)).toBe(false)
    expect(isOverlaySender('http://127.0.0.1:5173/', dev)).toBe(false)
    expect(isOverlaySender('https://localhost:5173/', dev)).toBe(false)
    expect(isOverlaySender(pathToFileURL(INDEX).href, dev)).toBe(false)
    expect(isOverlaySender(undefined, dev)).toBe(false)
  })
})
