import { Menu, Tray, nativeImage, screen, type MenuItemConstructorOptions } from 'electron'
import { INSTALLED_ONLY_NOTE, SETTINGS, isInstalledOnly, type BooleanSettingKey, type SettingDefinition } from '../shared/settings.js'
import { hotkeyLabel, type HotkeyRegistration } from '../shared/hotkey-status.js'
import type { SettingsSnapshot } from './settings-service.js'
import { trayIconPng, trayIconSize, trayLook, type TrayLook } from './tray-icon.js'
import { IDLE_TRAY_STATE, trayTooltip, type TrayState } from './tray-state.js'
import { updateItemLabel, type UpdateItem } from './updater.js'

export interface TrayHandle {
  /** Shows the state (`trayState`) on the icon and in the tooltip; cheap to call on every tick. */
  setState(state: TrayState): void
  /** A warning line in the menu (an outdated integration); clicking it calls `onNotice`. `undefined` removes it. */
  setNotice(text: string | undefined): void
  /**
   * The update item (`updateItemLabel`): its `check` click calls `onCheckUpdate`, its `install` click
   * `onInstallUpdate`, `busy` is disabled. Hidden at first; `undefined` (no updater, a repo build) hides it.
   */
  setUpdateItem(item: UpdateItem | undefined): void
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
 * Makes the image of a look for a display scale, and fails loudly if it is empty.
 *
 * The image holds one representation: the look drawn at the display's pixel size (`trayIconSize`),
 * marked with its scale factor. Not one per scale: on Windows, Electron 45 makes the tray's icon
 * handle from the image's 1x bitmap only (`Tray::SetImage` calls `NativeImage::GetHICON`, which
 * converts `image_.AsBitmap()`; Chromium's `ImageSkia::bitmap()` is the 1x representation, else the
 * one closest to 1x), so a 16 px representation next to the others would be the one shown, scaled up
 * by Windows. With a single representation, the one closest to 1x is the right size.
 *
 * `nativeImage.createFromBuffer` does NOT throw on data it cannot decode but returns an empty image,
 * and a tray icon created with an empty image is invisible on Windows. The app would run and the
 * user could not find it: a silent failure in an app whose only entry point is the tray icon. The
 * first image is made in `createTray`, so this throw reaches the `app.whenReady()` error handler,
 * which shows an error dialog.
 */
function iconImage(look: TrayLook, scaleFactor: number): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(trayIconPng(look, trayIconSize(scaleFactor)), { scaleFactor })
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
  /** The update item's `install` was clicked: install the downloaded update. */
  onInstallUpdate: () => void
  /** The update item's `check` was clicked: check for an update now. */
  onCheckUpdate: () => void
}): TrayHandle {
  // The scale of the primary display: the notification area sits on its taskbar.
  let scaleFactor = screen.getPrimaryDisplay().scaleFactor
  // One image per look, made once for the current scale: the tick asks for the same few images again
  // and again.
  const images = new Map<string, Electron.NativeImage>()
  const imageOf = (look: TrayLook): Electron.NativeImage => {
    const key = JSON.stringify(look)
    let image = images.get(key)
    if (image === undefined) {
      image = iconImage(look, scaleFactor)
      images.set(key, image)
    }
    return image
  }
  // The first tick follows right after `createTray` (`syncTray` in index.ts); until then, idle.
  let shownLook = trayLook(IDLE_TRAY_STATE, false)
  let shownKey = JSON.stringify(shownLook)
  let shownTooltip = trayTooltip(IDLE_TRAY_STATE)
  // The flash alternates on each `setState`, that is on each one-second tick.
  let flashOn = false

  const tray = new Tray(imageOf(shownLook))
  // A changed scaling (or another primary display) redraws the icon at the new size, without a restart.
  const onDisplaysChanged = (): void => {
    const next = screen.getPrimaryDisplay().scaleFactor
    if (destroyed || next === scaleFactor) return
    scaleFactor = next
    images.clear()
    tray.setImage(imageOf(shownLook))
  }
  screen.on('display-metrics-changed', onDisplaysChanged)
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
  tray.setToolTip(shownTooltip)
  // The menu is rebuilt on every change (update item, notice, settings, hotkey), so its state lives here:
  // otherwise a rebuilt menu would show the startup state, not what holds now.
  let settings = options.settings
  let hotkey = options.hotkey
  let notice: string | undefined
  let updateItem: UpdateItem | undefined
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

  // The click follows the item the label shows. Disabled while its check runs: a second click
  // would only wait for the same outcome. Installing waits for the `install` click.
  const updateItems = (): MenuItemConstructorOptions[] => {
    if (updateItem === undefined) return []
    const label = updateItemLabel(updateItem)
    switch (updateItem.kind) {
      case 'check':
        return [{ label, enabled: true, click: options.onCheckUpdate }]
      case 'busy':
        return [{ label, enabled: false }]
      case 'install':
        return [{ label, enabled: true, click: options.onInstallUpdate }]
    }
  }

  const buildMenu = (): Menu =>
    Menu.buildFromTemplate([
      { label: 'Megnyitás', click: options.onOpen },
      // The hotkey state is visible here, not only in the log. If registering fails (measured
      // live) or the value is mistyped, the user would otherwise just press it and see nothing
      // happen. The tray is then the only entry point left, so this is where to say it.
      { label: hotkeyLabel(hotkey), enabled: false },
      { label: 'Beállítások…', click: options.onSettings },
      { label: 'Napló megnyitása', click: options.onOpenLog },
      ...updateItems(),
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
      if (lookKey !== shownKey) {
        shownKey = lookKey
        shownLook = look
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
    setUpdateItem(item) {
      // The controller sends only changes (`showItem` in updater.ts), so every call rebuilds.
      if (destroyed) return
      updateItem = item
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
      screen.off('display-metrics-changed', onDisplaysChanged)
      screen.off('display-added', onDisplaysChanged)
      screen.off('display-removed', onDisplaysChanged)
      tray.destroy()
    },
  }
}
