import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWin32ProcessProbe, resolveClaudeDir } from '@claudeswitcher/core'
import { startDaemon, type Daemon } from '@claudeswitcher/daemon'
import { BrowserWindow, app, ipcMain } from 'electron'

const dirname = path.dirname(fileURLToPath(import.meta.url))

let daemon: Daemon | undefined
let overlay: BrowserWindow | undefined

function createOverlay(): BrowserWindow {
  const window = new BrowserWindow({
    width: 620,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(dirname, '../preload/index.js') },
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'))
  }
  window.on('blur', () => window.hide())
  return window
}

app.whenReady().then(async () => {
  daemon = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: createWin32ProcessProbe(),
  })
  await daemon.refresh()

  ipcMain.handle('daemon:connection', () => ({ port: daemon!.port, token: daemon!.token }))
  ipcMain.handle('daemon:state', () => daemon!.state())

  // Indulási összegzés a főprocessz stdoutjára. Ez teszi a Step 5 ellenőrzését
  // automatizálhatóvá: nem kell DevTools-konzolba gépelni ahhoz, hogy lássuk,
  // a daemon elindult és tényleg megtalálta a futó sessionöket.
  console.log(
    `[claudeswitcher] daemon on 127.0.0.1:${daemon.port}, ` +
      `${daemon.state().sessions.length} session(s) discovered`,
  )

  overlay = createOverlay()
  overlay.showInactive()
})

app.on('window-all-closed', () => {
  // Tálcaikonos app: az ablak bezárása nem lépteti ki.
})

app.on('before-quit', () => {
  void daemon?.stop()
})
