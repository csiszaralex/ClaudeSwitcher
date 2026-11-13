import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { INSTALLED_ONLY_NOTE, SETTINGS, isInstalledOnly, type BooleanSettingKey, type SettingDefinition } from '../shared/settings.js'
import { hotkeyLabel, type HotkeyRegistration } from '../shared/hotkey-status.js'
import { resourcesDir } from './resources.js'
import type { SettingsSnapshot } from './settings-service.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const resources = resourcesDir(app.isPackaged, process.resourcesPath, dirname)

export interface TrayHandle {
  setWaiting(count: number): void
  /** A warning line in the menu (an outdated integration); clicking it calls `onNotice`. `undefined` removes it. */
  setNotice(text: string | undefined): void
  /** The update line at the top of the menu (`updateLabel`); clicking it calls `onUpdate`. `undefined` removes it. */
  setUpdate(text: string | undefined): void
  /** Shows the current settings; the setup window can change them while the tray is open. */
  setSettings(snapshot: SettingsSnapshot): void
  /** Shows the hotkey that now holds, after a live switch. */
  setHotkey(registration: HotkeyRegistration): void
  destroy(): void
}

/** Shown after the label of an installed-only setting in a repo build, where the checkbox is read-only. */
const INSTALLED_ONLY_SUFFIX = ` (${INSTALLED_ONLY_NOTE})`

function isBooleanSetting(setting: SettingDefinition): setting is SettingDefinition & { key: BooleanSettingKey } {
  return setting.kind === 'boolean' && setting.key !== 'hotkey'
}

/** The quick toggles, in `SETTINGS` order. */
const TOGGLES = SETTINGS.filter(isBooleanSetting)

/**
 * Loads an icon, and fails loudly if it is empty.
 *
 * `nativeImage.createFromPath` does NOT throw on a missing or broken file but returns an empty
 * image, and a tray icon created with an empty image is invisible on Windows. The app would run and
 * the user could not find it: a silent failure in an app whose only entry point is the tray icon.
 * The throw reaches the `app.whenReady()` error handler, which shows an error dialog.
 */
function loadIcon(file: string): Electron.NativeImage {
  const iconPath = path.join(resources, file)
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error(`Tray icon missing or unreadable: ${iconPath}`)
  return image
}

export function createTray(options: {
  /** The settings at startup; later changes arrive through `setSettings`. */
  settings: SettingsSnapshot
  /** The hotkey registration result (see `registerHotkeyOrDefault`). */
  hotkey: HotkeyRegistration
  /**
   * The checkbox's new state. The caller applies it to the settings and calls `setSettings`
   * back, so the menu shows the state that actually holds (for example the OS login item).
   */
  onToggle: (key: BooleanSettingKey, enabled: boolean) => void
  onOpen: () => void
  /** Opens the setup window with every setting. */
  onSettings: () => void
  /** Opens the log file (`log-file.ts`) in the default application. */
  onOpenLog: () => void
  onQuit: () => void
  /** The notice line (an outdated integration) was clicked: the setup window handles the integration. */
  onNotice: () => void
  /** The update line was clicked: install the downloaded update. */
  onUpdate: () => void
}): TrayHandle {
  const idle = loadIcon('tray.png')
  const waiting = loadIcon('tray-waiting.png')

  const tray = new Tray(idle)
  // The menu is rebuilt on every change (update, notice, settings, hotkey), so its state lives here:
  // otherwise a rebuilt menu would show the startup state, not what holds now.
  let settings = options.settings
  let hotkey = options.hotkey
  let notice: string | undefined
  let update: string | undefined
  let destroyed = false

  const toggleItem = (setting: SettingDefinition & { key: BooleanSettingKey }): MenuItemConstructorOptions => {
    const readOnly = isInstalledOnly(setting.key) && !settings.installed
    return {
      label: readOnly ? `${setting.label}${INSTALLED_ONLY_SUFFIX}` : setting.label,
      type: 'checkbox',
      checked: settings.values[setting.key],
      enabled: !readOnly,
      // Electron flips the checkbox BEFORE the click, so `item.checked` is already the new state.
      // It takes effect at once, without a restart.
      click: (item) => {
        options.onToggle(setting.key, item.checked)
      },
    }
  }

  // The integration is installed and removed in the setup window only; the notice line opens it.
  const noticeItems = (): MenuItemConstructorOptions[] =>
    notice === undefined ? [] : [{ label: notice, click: options.onNotice }, { type: 'separator' }]

  // At the top, where it is seen first: installing waits for this click.
  const updateItems = (): MenuItemConstructorOptions[] =>
    update === undefined ? [] : [{ label: update, click: options.onUpdate }, { type: 'separator' }]

  const buildMenu = (): Menu =>
    Menu.buildFromTemplate([
      ...updateItems(),
      { label: 'Megnyitás', click: options.onOpen },
      // The hotkey state is visible here, not only in the log. If registering fails (measured
      // live) or the value is mistyped, the user would otherwise just press it and see nothing
      // happen. The tray is then the only entry point left, so this is where to say it.
      { label: hotkeyLabel(hotkey), enabled: false },
      { label: 'Beállítások…', click: options.onSettings },
      { label: 'Napló megnyitása', click: options.onOpenLog },
      { type: 'separator' },
      ...TOGGLES.map(toggleItem),
      { type: 'separator' },
      ...noticeItems(),
      { label: 'Kilépés', click: options.onQuit },
    ])
  const rebuild = (): void => {
    // Updates arrive asynchronously: one that lands during quit would reach a destroyed icon.
    if (destroyed) return
    tray.setContextMenu(buildMenu())
  }
  tray.setContextMenu(buildMenu())
  tray.on('click', options.onOpen)

  let lastCount = -1
  return {
    setWaiting(count) {
      if (count === lastCount) return
      lastCount = count
      tray.setImage(count > 0 ? waiting : idle)
      tray.setToolTip(
        count > 0 ? `ClaudeSwitcher: ${count} session vár rád` : 'ClaudeSwitcher',
      )
    },
    setNotice(text) {
      if (destroyed || text === notice) return
      notice = text
      rebuild()
    },
    setUpdate(text) {
      if (destroyed || text === update) return
      update = text
      rebuild()
    },
    setSettings(snapshot) {
      if (destroyed) return
      settings = snapshot
      rebuild()
    },
    setHotkey(registration) {
      if (destroyed) return
      hotkey = registration
      rebuild()
    },
    destroy() {
      destroyed = true
      tray.destroy()
    },
  }
}
