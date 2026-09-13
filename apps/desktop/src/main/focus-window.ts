import { execFile } from 'node:child_process'
import type { SessionView } from '@claudeswitcher/core'
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')

const GetTopWindow = user32.func('intptr GetTopWindow(intptr hWnd)')
const GetWindow = user32.func('intptr GetWindow(intptr hWnd, uint32 uCmd)')
const GetWindowThreadProcessId = user32.func(
  'uint32 GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *pid)',
)
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr hWnd)')
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(intptr hWnd)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr hWnd)')
const ShowWindow = user32.func('int ShowWindow(intptr hWnd, int nCmdShow)')

const SW_RESTORE = 9
const GW_HWNDNEXT = 2

/**
 * Felső korlát a bejárt ablakok számára. Egy Windows asztalon jellemzően néhány száz
 * top-level ablak van. A korlát azt védi ki, hogy egy váratlan típus — például ha a
 * `koffi` az `intptr`-t BigInt-ként adná vissza, amitől a `hwnd !== 0` sosem lenne
 * hamis — végtelen ciklusba ejtse az Electron főprocesszt, ami az egész appot
 * lefagyasztaná.
 */
const MAX_WINDOWS_SCANNED = 10_000

/**
 * A megadott processz első látható, címmel rendelkező top-level ablaka, vagy 0.
 *
 * Szándékosan a GetTopWindow + GetWindow láncot járjuk be, nem az EnumWindows-t:
 * az EnumWindows callbacket vár, amit koffi-ban regisztrálni kell, és a
 * regisztrált callback élettartama Electron main processzben könnyen elszáll.
 * A lánc bejárása ugyanazt adja, csak sima skalár hívásokkal.
 */
export function findMainWindow(targetPid: number): number {
  const pidOut: [number] = [0]
  let hwnd = Number(GetTopWindow(0))

  for (let scanned = 0; hwnd !== 0 && scanned < MAX_WINDOWS_SCANNED; scanned++) {
    if (IsWindowVisible(hwnd) && GetWindowTextLengthW(hwnd) > 0) {
      GetWindowThreadProcessId(hwnd, pidOut)
      if (pidOut[0] === targetPid) return hwnd
    }
    hwnd = Number(GetWindow(hwnd, GW_HWNDNEXT))
  }
  return 0
}

function focusByPid(pid: number): boolean {
  const hwnd = findMainWindow(pid)
  if (hwnd === 0) return false
  ShowWindow(hwnd, SW_RESTORE)
  return Boolean(SetForegroundWindow(hwnd))
}

function focusByCli(folder: string): Promise<boolean> {
  // A `code` Windowson `code.cmd`, ezért kell a shell. A shell viszont egy
  // stringgé fűzi össze az argumentumokat idézés nélkül, így egy szóközt
  // tartalmazó útvonal két argumentumra esne szét. Ezért idézzük.
  const quoted = `"${folder.replace(/"/g, '')}"`
  return new Promise((resolve) => {
    execFile('code', ['-r', quoted], { shell: true, windowsHide: true }, (error) => {
      resolve(error === null)
    })
  })
}

/**
 * Előtérbe hozza a session VSCode ablakát. Elsőként a lock fájlból ismert pid
 * alapján, mert az azonnali; ha az nem megy, a `code -r` a tartalék.
 */
export async function focusSessionWindow(view: SessionView): Promise<boolean> {
  if (view.windowPid !== undefined && focusByPid(view.windowPid)) return true
  const folder = view.workspaceFolder ?? view.cwd
  return focusByCli(folder)
}
