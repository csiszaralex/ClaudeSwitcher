import { describe, expect, it } from 'vitest'
import { loadPage, secureWebPreferences } from './harden-window.js'

describe('secureWebPreferences', () => {
  it('secureWebPreferences keeps contextIsolation, sandbox and no nodeIntegration', () => {
    expect(secureWebPreferences('/app/out/preload/index.cjs')).toStrictEqual({
      preload: '/app/out/preload/index.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
  })
})

describe('loadPage', () => {
  const recordingWindow = (): { calls: string[]; window: Parameters<typeof loadPage>[0] } => {
    const calls: string[] = []
    return {
      calls,
      window: {
        loadURL: (url) => {
          calls.push(`url ${url}`)
          return Promise.resolve()
        },
        loadFile: (filePath) => {
          calls.push(`file ${filePath}`)
          return Promise.resolve()
        },
      },
    }
  }

  it('loads the dev server page by URL', () => {
    const { calls, window } = recordingWindow()
    loadPage(window, { kind: 'dev-server', url: 'http://localhost:5173/index.html' })
    expect(calls).toEqual(['url http://localhost:5173/index.html'])
  })

  it('loads the built page from its file', () => {
    const { calls, window } = recordingWindow()
    loadPage(window, { kind: 'file', path: '/app/out/renderer/setup.html' })
    expect(calls).toEqual(['file /app/out/renderer/setup.html'])
  })
})
