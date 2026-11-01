import { describe, expect, it } from 'vitest'
import { createAutostart, type LoginItems } from './autostart.js'

/** A fake OS login item that records every write. */
function fakeItems(openAtLogin: boolean): LoginItems & { writes: boolean[] } {
  const writes: boolean[] = []
  let state = openAtLogin
  return {
    get: () => ({ openAtLogin: state }),
    set: (value) => {
      writes.push(value)
      state = value
    },
    writes,
  }
}

describe('createAutostart', () => {
  it('a repo build never registers', () => {
    const items = fakeItems(true)
    const autostart = createAutostart(false, items)
    autostart.set(true)
    expect(items.writes).toEqual([])
    expect(autostart.available).toBe(false)
    expect(autostart.enabled()).toBe(false)
  })

  it('a packaged build reads the OS state back', () => {
    const items = fakeItems(true)
    const autostart = createAutostart(true, items)
    expect(autostart.available).toBe(true)
    expect(autostart.enabled()).toBe(true)
    autostart.set(false)
    expect(items.writes).toEqual([false])
    expect(autostart.enabled()).toBe(false)
  })
})
