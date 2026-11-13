import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings.js'

// `tray.ts` needs a running Electron: stand-ins record the menu template it builds.
const built = vi.hoisted(() => ({ templates: [] as MenuItemConstructorOptions[][] }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      built.templates.push(template)
      return {}
    },
  },
  Tray: class {
    setContextMenu(): void {}
    on(): void {}
    setImage(): void {}
    setToolTip(): void {}
    destroy(): void {}
  },
}))

const { createTray } = await import('./tray.js')

function labels(template: MenuItemConstructorOptions[]): (string | undefined)[] {
  return template.map((item) => item.label)
}

describe('createTray menu', () => {
  it('has "Napló megnyitása" right after "Beállítások…", and its click calls onOpenLog', () => {
    const onOpenLog = vi.fn()
    const noop = (): void => {}
    createTray({
      settings: { values: DEFAULT_SETTINGS, confirmed: new Set(), installed: true },
      hotkey: { requested: 'Control+Shift+F9', status: 'registered' },
      onToggle: noop,
      onOpen: noop,
      onSettings: noop,
      onOpenLog,
      onQuit: noop,
      onNotice: noop,
      onUpdate: noop,
    })
    const template = built.templates.at(-1)
    expect(template).toBeDefined()
    const names = labels(template ?? [])
    const settingsAt = names.indexOf('Beállítások…')
    expect(settingsAt).toBeGreaterThan(-1)
    expect(names[settingsAt + 1]).toBe('Napló megnyitása')
    const item = template?.[settingsAt + 1]
    expect(onOpenLog).not.toHaveBeenCalled()
    // Electron passes (menuItem, window, event); the handler ignores them.
    ;(item?.click as (() => void) | undefined)?.()
    expect(onOpenLog).toHaveBeenCalledOnce()
  })
})
