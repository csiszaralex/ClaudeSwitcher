import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Menu, Tray, nativeImage } from 'electron'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const resources = path.join(dirname, '../../resources')

export interface TrayHandle {
  setWaiting(count: number): void
  destroy(): void
}

/**
 * Betölt egy ikont, és hangosan elbukik, ha üres.
 *
 * A `nativeImage.createFromPath` hiányzó vagy hibás fájlnál NEM dob, hanem üres képet
 * ad vissza, és egy üres képpel létrehozott tálcaikon Windowson láthatatlan. Az app
 * így futna, a felhasználó pedig nem találná meg — csendes hiba egy olyan appban, aminek
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
  onOpen(): void
  onQuit(): void
  onInstall(): void
  onUninstall(): void
}): TrayHandle {
  const idle = loadIcon('tray.png')
  const waiting = loadIcon('tray-waiting.png')

  const tray = new Tray(idle)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Megnyitás', click: options.onOpen },
      { type: 'separator' },
      { label: 'Claude Code integráció telepítése', click: options.onInstall },
      { label: 'Claude Code integráció eltávolítása', click: options.onUninstall },
      { type: 'separator' },
      { label: 'Kilépés', click: options.onQuit },
    ]),
  )
  tray.on('click', options.onOpen)

  let lastCount = -1
  return {
    setWaiting(count) {
      if (count === lastCount) return
      lastCount = count
      tray.setImage(count > 0 ? waiting : idle)
      tray.setToolTip(
        count > 0 ? `ClaudeSwitcher — ${count} session vár rád` : 'ClaudeSwitcher',
      )
    },
    destroy() {
      tray.destroy()
    },
  }
}
