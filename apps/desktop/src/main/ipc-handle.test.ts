import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createHandleFrom, type InvokeEvent, type InvokeListener } from './ipc-handle.js'
import { rendererLocation } from './ipc-sender.js'

const OWN = rendererLocation(undefined, 'C:\\app\\out\\renderer', 'index.html')
const OTHER = rendererLocation(undefined, 'C:\\app\\out\\renderer', 'setup.html')

const ownEvent: InvokeEvent = { senderFrame: { url: pathToFileURL('C:\\app\\out\\renderer\\index.html').href } }
const foreignEvent: InvokeEvent = { senderFrame: { url: 'https://example.com/' } }

/** A fake `ipcMain`: records every registration, and `invoke` calls the registered listener. */
function fakeIpc(): { handle: (channel: string, listener: InvokeListener) => void; channels: string[]; invoke: (channel: string, event: InvokeEvent, ...args: unknown[]) => unknown } {
  const listeners = new Map<string, InvokeListener>()
  const channels: string[] = []
  return {
    handle: (channel, listener) => {
      channels.push(channel)
      listeners.set(channel, listener)
    },
    channels,
    invoke: (channel, event, ...args) => {
      const listener = listeners.get(channel)
      if (listener === undefined) throw new Error(`no handler for ${channel}`)
      return listener(event, ...args)
    },
  }
}

describe('handleFrom', () => {
  it('calls the handler for the own page', () => {
    const ipc = fakeIpc()
    const handleFrom = createHandleFrom(ipc)
    const handler = vi.fn((first: unknown, second: unknown) => ({ first, second }))
    handleFrom(OWN, 'test:echo', handler)

    expect(ipc.invoke('test:echo', ownEvent, 'a', 2)).toEqual({ first: 'a', second: 2 })
    expect(handler).toHaveBeenCalledWith('a', 2)
  })

  it('refuses a foreign sender without calling the handler, as today', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ipc = fakeIpc()
    const handleFrom = createHandleFrom(ipc)
    const handler = vi.fn(() => 'answered')
    handleFrom(OWN, 'test:throws', handler)
    handleFrom(OWN, 'test:replies', handler, (reason) => ({ ok: false, reason }))
    handleFrom(OWN, 'test:false', handler, () => false)

    // Without a foreign reply the handler throws, so the renderer's `invoke` rejects.
    expect(() => ipc.invoke('test:throws', foreignEvent)).toThrow(new Error('Ismeretlen küldő.'))
    expect(ipc.invoke('test:replies', foreignEvent)).toEqual({ ok: false, reason: 'Ismeretlen küldő.' })
    expect(ipc.invoke('test:false', foreignEvent)).toBe(false)
    // Our other page is foreign too, and so is a sender whose frame is gone.
    expect(() => {
      handleFrom(OTHER, 'test:other', handler)
      return ipc.invoke('test:other', ownEvent)
    }).toThrow('Ismeretlen küldő.')
    expect(() => ipc.invoke('test:throws', { senderFrame: null })).toThrow('Ismeretlen küldő.')

    expect(handler).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalledWith('[claudeswitcher] refused test:throws from a foreign sender: https://example.com/')
    expect(errors).toHaveBeenCalledWith('[claudeswitcher] refused test:throws from a foreign sender: (no frame)')
    errors.mockRestore()
  })

  it('registers each channel once', () => {
    const ipc = fakeIpc()
    const handleFrom = createHandleFrom(ipc)
    handleFrom(OWN, 'test:a', () => undefined)
    handleFrom(OWN, 'test:b', () => undefined)
    ipc.invoke('test:a', ownEvent)
    ipc.invoke('test:a', ownEvent)

    // The sender check runs inside the one listener, so calls never register again.
    expect(ipc.channels).toEqual(['test:a', 'test:b'])
  })
})
