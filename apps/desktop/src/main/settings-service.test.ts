import { describe, expect, it, vi } from 'vitest'
import type { SettingKey } from '../shared/settings.js'
import type { Autostart } from './autostart.js'
import type { StoredConfig, StoredValues } from './config.js'
import { createSettingsService, type SettingsSnapshot } from './settings-service.js'

function stored(confirmed: SettingKey[] = []): StoredConfig {
  return { values: { hideAfterLastDecision: true, jumpToTab: true, checkForUpdates: true, hotkey: 'Shift+Alt+Space' }, confirmed: new Set(confirmed) }
}

/** A fake autostart that keeps its state in memory and records every write. */
function fakeAutostart(available: boolean, initial = true): Autostart & { writes: boolean[] } {
  const writes: boolean[] = []
  let state = initial
  return {
    available,
    enabled: () => available && state,
    set: (value) => {
      writes.push(value)
      if (available) state = value
    },
    writes,
  }
}

interface PersistCall {
  patch: Partial<StoredValues>
  confirm: readonly SettingKey[]
}

function fakePersist(result: boolean): {
  persist: (patch: Partial<StoredValues>, confirm: readonly SettingKey[]) => Promise<boolean>
  calls: PersistCall[]
} {
  const calls: PersistCall[] = []
  return {
    persist: (patch, confirm) => {
      calls.push({ patch, confirm })
      return Promise.resolve(result)
    },
    calls,
  }
}

describe('createSettingsService', () => {
  it('apply changes values in memory even if persisting fails', async () => {
    const { persist } = fakePersist(false)
    const service = createSettingsService({ stored: stored(), autostart: fakeAutostart(true), persist })
    const snapshot = await service.apply({ jumpToTab: false }, ['jumpToTab'])
    expect(snapshot.values.jumpToTab).toBe(false)
    expect(service.snapshot().values.jumpToTab).toBe(false)
  })

  it('autostart goes to the OS, not to persist', async () => {
    const { persist, calls } = fakePersist(true)
    const autostart = fakeAutostart(true)
    const service = createSettingsService({ stored: stored(), autostart, persist })
    await service.apply({ autostart: false }, ['autostart'])
    expect(autostart.writes).toEqual([false])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.patch).not.toHaveProperty('autostart')
    expect(calls[0]?.confirm).toContain('autostart')
    expect(service.snapshot().confirmed.has('autostart')).toBe(true)
  })

  it('autostart is not confirmed where it is unavailable', async () => {
    const { persist, calls } = fakePersist(true)
    const service = createSettingsService({ stored: stored(), autostart: fakeAutostart(false), persist })
    const snapshot = await service.apply({}, ['autostart', 'jumpToTab'])
    expect(calls[0]?.confirm).toEqual(['jumpToTab'])
    expect([...snapshot.confirmed]).toEqual(['jumpToTab'])
    expect(snapshot.installed).toBe(false)
  })

  it('a repo build neither writes nor confirms checkForUpdates', async () => {
    const { persist, calls } = fakePersist(true)
    const service = createSettingsService({ stored: stored(), autostart: fakeAutostart(false), persist })
    const snapshot = await service.apply({ checkForUpdates: false, jumpToTab: false }, ['checkForUpdates', 'jumpToTab'])
    expect(calls[0]?.patch).toEqual({ jumpToTab: false })
    expect(calls[0]?.confirm).toEqual(['jumpToTab'])
    expect(snapshot.values.checkForUpdates).toBe(true)
    expect([...snapshot.confirmed]).toEqual(['jumpToTab'])
  })

  it('the installed app writes and confirms checkForUpdates', async () => {
    const { persist, calls } = fakePersist(true)
    const service = createSettingsService({ stored: stored(), autostart: fakeAutostart(true), persist })
    await service.apply({ checkForUpdates: false }, ['checkForUpdates'])
    expect(calls[0]?.patch).toEqual({ checkForUpdates: false })
    expect(calls[0]?.confirm).toEqual(['checkForUpdates'])
  })

  it('listeners get every change', async () => {
    const { persist } = fakePersist(true)
    const service = createSettingsService({ stored: stored(), autostart: fakeAutostart(true), persist })
    const seen: SettingsSnapshot[] = []
    const ignored: SettingsSnapshot[] = []
    service.onChange((snapshot) => seen.push(snapshot))
    const unsubscribe = service.onChange((snapshot) => ignored.push(snapshot))
    unsubscribe()
    await service.apply({ jumpToTab: false }, [])
    await service.apply({ hotkey: 'F9' }, ['hotkey'])
    expect(seen.map((snapshot) => snapshot.values.jumpToTab)).toEqual([false, false])
    expect(seen.map((snapshot) => snapshot.values.hotkey)).toEqual(['Shift+Alt+Space', 'F9'])
    expect(ignored).toEqual([])
  })

  it('one failing listener does not keep the others out of date', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { persist } = fakePersist(true)
    const service = createSettingsService({ stored: stored(), autostart: fakeAutostart(true), persist })
    const seen: boolean[] = []
    service.onChange(() => {
      throw new Error('broken listener')
    })
    service.onChange((snapshot) => seen.push(snapshot.values.jumpToTab))
    await service.apply({ jumpToTab: false }, [])
    expect(seen).toEqual([false])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('snapshot reads autostart from the OS', () => {
    const { persist } = fakePersist(true)
    const autostart = fakeAutostart(true, false)
    const service = createSettingsService({ stored: stored(['hotkey']), autostart, persist })
    expect(service.snapshot().values.autostart).toBe(autostart.enabled())
    expect(service.snapshot().values.autostart).toBe(false)
    expect([...service.snapshot().confirmed]).toEqual(['hotkey'])
  })
})
