import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { INSTALLED_ONLY_NOTE, SETTINGS, isInstalledOnly, type BooleanSettingKey, type SettingDefinition } from '../shared/settings.js'
import { hotkeyLabel, type HotkeyRegistration } from '../shared/hotkey-status.js'
import type { SettingsSnapshot } from './settings-service.js'
import { trayIconPng, trayLook, type TrayLook } from './tray-icon.js'
import { IDLE_TRAY_STATE, trayTooltip, type TrayState } from './tray-state.js'

export interface TrayHandle {
  /** Shows the state (`trayState`) on the icon and in the tooltip; cheap to call on every tick. */
  setState(state: TrayState): void
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
 * Makes the image of a look, and fails loudly if it is empty.
 *
 * `nativeImage.createFromBuffer` does NOT throw on data it cannot decode but returns an empty image,
 * and a tray icon created with an empty image is invisible on Windows. The app would run and the
 * user could not find it: a silent failure in an app whose only entry point is the tray icon. The
 * first image is made in `createTray`, so this throw reaches the `app.whenReady()` error handler,
 * which shows an error dialog.
 */
function iconImage(look: TrayLook): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(trayIconPng(look))
  if (image.isEmpty()) throw new Error(`Tray icon could not be made: ${JSON.stringify(look)}`)
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
  // One image per look, made once: the tick asks for the same few images again and again.
  const images = new Map<string, Electron.NativeImage>()
  const imageOf = (look: TrayLook): Electron.NativeImage => {
    const key = JSON.stringify(look)
    let image = images.get(key)
    if (image === undefined) {
      image = iconImage(look)
      images.set(key, image)
    }
    return image
  }
  // The first tick follows right after `createTray` (`syncTray` in index.ts); until then, idle.
  let shownLook = JSON.stringify(trayLook(IDLE_TRAY_STATE, false))
  let shownTooltip = trayTooltip(IDLE_TRAY_STATE)
  // The flash alternates on each `setState`, that is on each one-second tick.
  let flashOn = false

  const tray = new Tray(imageOf(trayLook(IDLE_TRAY_STATE, false)))
  tray.setToolTip(shownTooltip)
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

  return {
    setState(state) {
      if (destroyed) return
      flashOn = state.flash && !flashOn
      const look = trayLook(state, flashOn)
      const lookKey = JSON.stringify(look)
      if (lookKey !== shownLook) {
        shownLook = lookKey
        tray.setImage(imageOf(look))
      }
      const tooltip = trayTooltip(state)
      if (tooltip !== shownTooltip) {
        shownTooltip = tooltip
        tray.setToolTip(tooltip)
      }
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
