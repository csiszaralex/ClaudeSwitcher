import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings.js'
import { decodePng } from './png-testing.js'

// `tray.ts` needs a running Electron: stand-ins record the menu template it builds and the images
// it shows. An image stand-in carries the PNG it was made from and its scale factor, so a test can
// tell two apart. The screen stand-in has a primary display whose scale a test can change.
const built = vi.hoisted(() => ({
  templates: [] as MenuItemConstructorOptions[][],
  images: [] as Buffer[],
  scaleFactors: [] as (number | undefined)[],
}))
const display = vi.hoisted(() => ({
  scaleFactor: 1,
  listeners: new Map<string, Set<() => void>>(),
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (png: Buffer, options?: { scaleFactor?: number }) => {
      built.scaleFactors.push(options?.scaleFactor)
      return { isEmpty: () => false, png }
    },
  },
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: display.scaleFactor }),
    on: (event: string, listener: () => void) => {
      const listeners = display.listeners.get(event) ?? new Set()
      listeners.add(listener)
      display.listeners.set(event, listeners)
    },
    off: (event: string, listener: () => void) => {
      display.listeners.get(event)?.delete(listener)
    },
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      built.templates.push(template)
      return {}
    },
  },
  Tray: class {
    setContextMenu(): void {}
    on(): void {}
    setImage(image: { png: Buffer }): void {
      built.images.push(image.png)
    }
    setToolTip(): void {}
    destroy(): void {}
  },
}))

const { createTray } = await import('./tray.js')
const { IDLE_TRAY_STATE } = await import('./tray-state.js')

const noop = (): void => {}

function newTray(
  onOpenLog: () => void = noop,
  onCheckUpdate: () => void = noop,
  onInstallUpdate: () => void = noop,
): ReturnType<typeof createTray> {
  return createTray({
    settings: { values: DEFAULT_SETTINGS, confirmed: new Set(), installed: true },
    hotkey: { requested: 'Control+Shift+F9', status: 'registered' },
    onToggle: noop,
    onOpen: noop,
    onSettings: noop,
    onOpenLog,
    onQuit: noop,
    onNotice: noop,
    onInstallUpdate,
    onCheckUpdate,
  })
}

function labels(template: MenuItemConstructorOptions[]): (string | undefined)[] {
  return template.map((item) => item.label)
}

describe('createTray menu', () => {
  it('has "Napló megnyitása" right after "Beállítások…", and its click calls onOpenLog', () => {
    const onOpenLog = vi.fn()
    newTray(onOpenLog)
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

  it('has no update item until one is set (a repo build has none)', () => {
    newTray()
    // No update item in any state: none of its labels starts like this (the `checkForUpdates`
    // toggle reads "Frissítések keresése").
    const updateLabels = labels(built.templates.at(-1) ?? []).filter((label) => label?.startsWith('Frissítés ') === true)
    expect(updateLabels).toEqual([])
  })

  it('shows the one update item after "Napló megnyitása": check calls onCheckUpdate, busy is disabled, install calls onInstallUpdate', () => {
    const onCheckUpdate = vi.fn()
    const onInstallUpdate = vi.fn()
    const tray = newTray(noop, onCheckUpdate, onInstallUpdate)
    const click = (item: MenuItemConstructorOptions | undefined): void => {
      ;(item?.click as (() => void) | undefined)?.()
    }
    tray.setUpdateItem({ kind: 'check' })
    let template = built.templates.at(-1) ?? []
    const at = labels(template).indexOf('Napló megnyitása') + 1
    const check = template[at]
    expect(check?.label).toBe('Frissítés keresése most')
    expect(check?.enabled).toBe(true)
    click(check)
    expect(onCheckUpdate).toHaveBeenCalledOnce()

    tray.setUpdateItem({ kind: 'busy' })
    template = built.templates.at(-1) ?? []
    expect(template[at]?.label).toBe('Frissítés keresése…')
    expect(template[at]?.enabled).toBe(false)

    tray.setUpdateItem({ kind: 'install', version: '0.2.0' })
    template = built.templates.at(-1) ?? []
    const installItem = template[at]
    expect(installItem?.label).toBe('Frissítés a 0.2.0 verzióra')
    expect(installItem?.enabled).toBe(true)
    click(installItem)
    expect(onInstallUpdate).toHaveBeenCalledOnce()
    expect(onCheckUpdate).toHaveBeenCalledOnce()
    // One item: no line at the top of the menu, and no separate check item.
    expect(template[0]?.label).toBe('Megnyitás')
    expect(labels(template).filter((label) => label?.startsWith('Frissítés ') === true)).toEqual(['Frissítés a 0.2.0 verzióra'])

    tray.setUpdateItem(undefined)
    expect(labels(built.templates.at(-1) ?? [])).not.toContain('Frissítés a 0.2.0 verzióra')
  })
})

describe('createTray icon', () => {
  it('sets the image only when the look changes', () => {
    const tray = newTray()
    built.images.length = 0
    const waiting = { ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'yes-no' as const }
    tray.setState(IDLE_TRAY_STATE)
    expect(built.images).toHaveLength(0)
    tray.setState(waiting)
    tray.setState(waiting)
    expect(built.images).toHaveLength(1)
  })

  it('alternates two images on each tick while flashing, and returns to the normal one after', () => {
    const tray = newTray()
    const waiting = { ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'yes-no' as const }
    tray.setState(waiting)
    built.images.length = 0
    const flashing = { ...waiting, flash: true }
    // Three ticks: flash frame, normal icon, flash frame.
    for (let tick = 0; tick < 3; tick++) tray.setState(flashing)
    expect(built.images).toHaveLength(3)
    const [flashFrame, normal, flashAgain] = built.images
    expect(flashFrame?.equals(normal ?? Buffer.alloc(0))).toBe(false)
    expect(flashFrame?.equals(flashAgain ?? Buffer.alloc(0))).toBe(true)
    // The flash ends on the normal icon, the one shown between the flash frames.
    tray.setState(waiting)
    expect(built.images).toHaveLength(4)
    expect(built.images.at(-1)?.equals(normal ?? Buffer.alloc(0))).toBe(true)
  })

  /** The pixel size of the last image the tray showed. */
  const shownSize = (): number => decodePng(built.images.at(-1) ?? Buffer.alloc(0)).width
  /** Changes the primary display's scale and tells the listeners, as Electron's `screen` does. */
  const rescale = (scaleFactor: number): void => {
    display.scaleFactor = scaleFactor
    for (const listener of display.listeners.get('display-metrics-changed') ?? []) listener()
  }

  it('draws the icon at the pixel size of the primary display, marked with its scale', () => {
    display.scaleFactor = 1.5
    const tray = newTray()
    built.scaleFactors.length = 0
    tray.setState({ ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'choice' })
    expect(shownSize()).toBe(24)
    expect(built.scaleFactors).toEqual([1.5])
    tray.destroy()
    display.scaleFactor = 1
  })

  it('redraws the shown look at the new size when the scale changes, and stops listening once destroyed', () => {
    display.scaleFactor = 1
    // The other tests' trays are never destroyed: drop their listeners, so only this tray redraws.
    display.listeners.clear()
    const listening = (): number => [...display.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
    const tray = newTray()
    expect(listening()).toBeGreaterThan(0)
    tray.setState({ ...IDLE_TRAY_STATE, waitingCount: 1, wait: 'yes-no' })
    const atOne = built.images.at(-1)
    expect(shownSize()).toBe(16)
    rescale(2)
    expect(shownSize()).toBe(32)
    // The same scale again draws nothing new.
    const count = built.images.length
    rescale(2)
    expect(built.images).toHaveLength(count)
    // Back at 1x: the same look as before, drawn again at 16 px.
    rescale(1)
    expect(built.images.at(-1)?.equals(atOne ?? Buffer.alloc(0))).toBe(true)
    tray.destroy()
    expect(listening()).toBe(0)
  })
})
