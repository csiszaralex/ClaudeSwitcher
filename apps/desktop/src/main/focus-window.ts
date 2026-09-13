import { exec } from 'node:child_process'
import { createRequire } from 'node:module'
import type { SessionView } from '@claudeswitcher/core'

// Nem `require`-nek nevezzük: a CJS bundle modulburkolójában a `require` már
// paraméterként létezik, és egy azonos nevű `const` ütközne vele.
const requireNative = createRequire(import.meta.url)

const SW_RESTORE = 9
const GW_HWNDNEXT = 2

interface User32 {
  GetTopWindow(hWnd: number): number
  GetWindow(hWnd: number, uCmd: number): number
  GetWindowThreadProcessId(hWnd: number, pid: [number]): number
  IsWindowVisible(hWnd: number): number
  GetWindowTextLengthW(hWnd: number): number
  GetForegroundWindow(): number
  SetForegroundWindow(hWnd: number): number
  ShowWindow(hWnd: number, nCmdShow: number): number
}

/** `undefined`: még nem próbáltuk. `null`: a betöltés elbukott. */
let user32: User32 | null | undefined

/**
 * Lustán tölti be a user32 kötéseket, és egy hibát elnyel.
 *
 * Szándékosan nem modulszinten: a `focus-window.ts`-t az `index.ts` importálja még az
 * `app.whenReady()` előtt, így egy modulszintű koffi-hiba az indulási hibadialógus
 * bekötése ELŐTT dobna — és az app dialógus nélkül, csendben halna meg. Így egy
 * elérhetetlen natív modul csak a gyors fókuszutat kapcsolja ki; a `code -r` tartalék
 * tovább működik.
 */
function loadUser32(): User32 | null {
  if (user32 !== undefined) return user32
  try {
    const koffi = requireNative('koffi') as typeof import('koffi')
    const lib = koffi.load('user32.dll')
    user32 = {
      GetTopWindow: lib.func('intptr GetTopWindow(intptr hWnd)'),
      GetWindow: lib.func('intptr GetWindow(intptr hWnd, uint32 uCmd)'),
      GetWindowThreadProcessId: lib.func(
        'uint32 GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *pid)',
      ),
      // A Win32 BOOL egy 4 bájtos int, nem az 1 bájtos C bool.
      IsWindowVisible: lib.func('int IsWindowVisible(intptr hWnd)'),
      GetWindowTextLengthW: lib.func('int GetWindowTextLengthW(intptr hWnd)'),
      GetForegroundWindow: lib.func('intptr GetForegroundWindow()'),
      SetForegroundWindow: lib.func('int SetForegroundWindow(intptr hWnd)'),
      ShowWindow: lib.func('int ShowWindow(intptr hWnd, int nCmdShow)'),
    }
  } catch (error) {
    console.error('[focus] user32 bindings unavailable; falling back to code -r only', error)
    user32 = null
  }
  return user32
}

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
  const api = loadUser32()
  if (api === null) return 0

  const pidOut: [number] = [0]
  let hwnd = Number(api.GetTopWindow(0))

  for (let scanned = 0; hwnd !== 0 && scanned < MAX_WINDOWS_SCANNED; scanned++) {
    if (api.IsWindowVisible(hwnd) !== 0 && api.GetWindowTextLengthW(hwnd) > 0) {
      api.GetWindowThreadProcessId(hwnd, pidOut)
      if (pidOut[0] === targetPid) return hwnd
    }
    hwnd = Number(api.GetWindow(hwnd, GW_HWNDNEXT))
  }
  return 0
}

/**
 * Igaz, ha a gyors, pid-alapú fókuszút elérhető, azaz a user32 kötések betöltődtek.
 * Az indulási naplóhoz: a lusta betöltés miatt a `koffi` különben csak az első
 * fókuszkérésnél töltődne be, és addig semmi nem bizonyítaná, hogy az Electron
 * főprocesszben működik.
 */
export function isFastFocusAvailable(): boolean {
  return loadUser32() !== null
}

/** Az aktuálisan előtérben lévő ablak, vagy 0. Csak olvas, semmit nem hoz előre. */
export function foregroundWindow(): number {
  const api = loadUser32()
  return api === null ? 0 : Number(api.GetForegroundWindow())
}

function focusByPid(pid: number): boolean {
  const api = loadUser32()
  if (api === null) return false
  const hwnd = findMainWindow(pid)
  if (hwnd === 0) return false

  api.ShowWindow(hwnd, SW_RESTORE)
  api.SetForegroundWindow(hwnd)

  // A SetForegroundWindow visszatérési értéke nem megbízható. A Windows előtér-
  // zárolása mellett „sikert" jelenthet, miközben csak a tálcagombot villogtatja. Ha
  // ezt elhinnénk, a `code -r` tartalék sosem futna le, a felhasználó pedig azt
  // látná, hogy az overlay eltűnik, és semmi nem történik. Ezért megnézzük, mi
  // került ténylegesen előtérbe.
  return foregroundWindow() === hwnd
}

/**
 * Karakterek, amiket a cmd.exe idézőjelen belül is értelmez: a `%` környezeti
 * változóként bontódik ki, egy `"` pedig magát az idézést törné meg. Az `&`, `^`,
 * `|`, `<`, `>`, `(`, `)` idézőjelen belül ártalmatlan — ezt a review empirikusan
 * lemérte.
 */
const CMD_UNSAFE_IN_QUOTES = /[%"]/

/** Igaz, ha a mappa biztonságosan átadható a `code -r`-nek egy cmd.exe shellen át. */
export function isSafeForCli(folder: string): boolean {
  return !CMD_UNSAFE_IN_QUOTES.test(folder)
}

/**
 * Idézőjelbe tesz egy mappát úgy, hogy a Windows CRT argv-feldolgozója pontosan azt
 * adja vissza.
 *
 * A CRT a záró idézőjel előtti backslashokat escape-ként kezeli: N backslash és egy
 * `"` N/2 backslasht ad, páratlan N esetén pedig a `"`-t is literálisnak veszi. Egy
 * sima idézés mellett így egy `C:\` workspace `C:"`-ként érkezne, egy `\\server\share\`
 * elveszítené a lezárását, és egy `double\\` egy backslasht — vagyis a meghajtó- és
 * megosztásgyökér workspace-ek csendben rossz útvonalat kapnának. Mérve, nem
 * feltételezve: a sima idézés 7 esetből 4-ben rontotta el az útvonalat.
 *
 * A záró backslash-futam megduplázása ezt kiegyenlíti. Máshol a backslash literális, és
 * `"` a mappában nem fordulhat elő, mert az `isSafeForCli` kizárja.
 */
export function quoteForCli(folder: string): string {
  return `"${folder.replace(/(\\+)$/, '$1$1')}"`
}

function focusByCli(folder: string): Promise<boolean> {
  // Egy ilyen mappanévnél inkább nem próbálkozunk: a `%` kibontása csendben egy MÁSIK
  // útvonalat nyitna meg. Egy elmaradt fókusz jobb, mint egy rossz.
  if (!isSafeForCli(folder)) return Promise.resolve(false)

  // A `code` Windowson `code.cmd`, ezért kell a shell. A teljes parancsot egyetlen
  // stringként adjuk át, az idézést pedig a quoteForCli végzi, egy helyen és tesztelve.
  return new Promise((resolve) => {
    exec(`code -r ${quoteForCli(folder)}`, { windowsHide: true }, (error) => {
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
