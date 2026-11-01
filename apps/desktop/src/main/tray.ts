import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { SETTINGS, type BooleanSettingKey, type SettingDefinition } from '../shared/settings.js'
import { hotkeyLabel, type HotkeyRegistration } from './hotkey.js'
import { resourcesDir } from './resources.js'
import type { SettingsSnapshot } from './settings-service.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const resources = resourcesDir(app.isPackaged, process.resourcesPath, dirname)

export interface TrayHandle {
  setWaiting(count: number): void
  /** A warning line in the menu (for example an outdated integration); `undefined` removes it. */
  setNotice(text: string | undefined): void
  /** Shows the current settings; the setup window can change them while the tray is open. */
  setSettings(snapshot: SettingsSnapshot): void
  /** Shows the hotkey that now holds, after a live switch. */
  setHotkey(registration: HotkeyRegistration): void
  destroy(): void
}

/** Shown after the autostart label in a repo build, where the checkbox is read-only. */
const AUTOSTART_UNAVAILABLE_SUFFIX = ' (csak a telepített appban)'

function isBooleanSetting(setting: SettingDefinition): setting is SettingDefinition & { key: BooleanSettingKey } {
  return setting.kind === 'boolean' && setting.key !== 'hotkey'
}

/** The quick toggles, in `SETTINGS` order. */
const TOGGLES = SETTINGS.filter(isBooleanSetting)

/**
 * Betölt egy ikont, és hangosan elbukik, ha üres.
 *
 * A `nativeImage.createFromPath` hiányzó vagy hibás fájlnál NEM dob, hanem üres képet
 * ad vissza, és egy üres képpel létrehozott tálcaikon Windowson láthatatlan. Az app
 * így futna, a felhasználó pedig nem találná meg: csendes hiba egy olyan appban, aminek
 * a tálcaikon az egyetlen belépési pontja. A dobás az `app.whenReady()` hibakezelőjéhez
 * jut, ami hibadialógust mutat.
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
  onQuit: () => void
  onInstall: () => void
  onUninstall: () => void
}): TrayHandle {
  const idle = loadIcon('tray.png')
  const waiting = loadIcon('tray-waiting.png')

  const tray = new Tray(idle)
  // The menu is rebuilt on every change (notice, settings, hotkey), so its state lives here:
  // otherwise a rebuilt menu would show the startup state, not what holds now.
  let settings = options.settings
  let hotkey = options.hotkey
  let notice: string | undefined
  let destroyed = false

  const toggleItem = (setting: SettingDefinition & { key: BooleanSettingKey }): MenuItemConstructorOptions => {
    const readOnly = setting.key === 'autostart' && !settings.autostartAvailable
    return {
      label: readOnly ? `${setting.label}${AUTOSTART_UNAVAILABLE_SUFFIX}` : setting.label,
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

  const buildMenu = (): Menu =>
    Menu.buildFromTemplate([
      { label: 'Megnyitás', click: options.onOpen },
      // The hotkey state is visible here, not only in the log. If registering fails (measured on
      // this machine) or the value is mistyped, the user would otherwise just press it and see
      // nothing happen. The tray is then the only entry point left, so this is where to say it.
      { label: hotkeyLabel(hotkey), enabled: false },
      { label: 'Beállítások…', click: options.onSettings },
      { type: 'separator' },
      ...TOGGLES.map(toggleItem),
      { type: 'separator' },
      // Directly above the install item, because that is the thing to do.
      ...(notice === undefined ? [] : [{ label: notice, enabled: false }]),
      { label: 'Claude Code integráció telepítése', click: options.onInstall },
      { label: 'Claude Code integráció eltávolítása', click: options.onUninstall },
      { type: 'separator' },
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
