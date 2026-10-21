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
  onOpen: () => void
  onQuit: () => void
  onInstall: () => void
  onUninstall: () => void
  /** Megnyitja a config fájlt, hogy a gyorsbillentyű átírható legyen. */
  onEditHotkey: () => void
  /** A gyorsbillentyű, és hogy sikerült-e lefoglalni. */
  hotkey: { accelerator: string; registered: boolean }
  /** Az auto-hide kezdőállapota a configból. */
  hideAfterLastDecision: boolean
  /** A pipa új állapota; a hívó menti el és adja tovább az overlaynek. */
  onToggleHideAfterLastDecision: (enabled: boolean) => void
  /** A tab-ugrás kezdőállapota a configból. */
  jumpToTab: boolean
  /** A pipa új állapota; a hívó menti el, és a következő fókuszkérés már ezt használja. */
  onToggleJumpToTab: (enabled: boolean) => void
}): TrayHandle {
  const idle = loadIcon('tray.png')
  const waiting = loadIcon('tray-waiting.png')

  const tray = new Tray(idle)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Megnyitás', click: options.onOpen },
      // A gyorsbillentyű állapota látszik, nem csak a naplóban. Ha a foglalás nem sikerül —
      // amit ezen a gépen le is mértünk —, a felhasználó különben csak azt tapasztalná,
      // hogy megnyomja és nem történik semmi, magyarázat nélkül. A tálca ilyenkor az
      // egyetlen megmaradt belépési pont, tehát itt kell megmondani.
      {
        label: options.hotkey.registered
          ? `Gyorsbillentyű: ${options.hotkey.accelerator}`
          : `Gyorsbillentyű: ${options.hotkey.accelerator} — FOGLALT, nem működik`,
        enabled: false,
      },
      { label: 'Gyorsbillentyű átállítása… (újraindítás után él)', click: options.onEditHotkey },
      { type: 'separator' },
      {
        // A pipát az Electron a kattintás ELŐTT átbillenti, tehát az `item.checked` már az új
        // állapot. Azonnal hat, újraindítás nélkül: az overlay minden döntés után a mainből kérdezi.
        label: 'Elrejtés az utolsó döntés után',
        type: 'checkbox',
        checked: options.hideAfterLastDecision,
        click: (item) => {
          options.onToggleHideAfterLastDecision(item.checked)
        },
      },
      {
        // Kikapcsolva csak az ablak jön elő, a tab nem — pontosan az M1-es viselkedés.
        label: 'Ugrás a pontos Claude-tabra',
        type: 'checkbox',
        checked: options.jumpToTab,
        click: (item) => {
          options.onToggleJumpToTab(item.checked)
        },
      },
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
