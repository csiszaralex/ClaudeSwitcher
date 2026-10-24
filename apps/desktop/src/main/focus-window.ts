import { exec } from 'node:child_process'
import { createRequire } from 'node:module'
import type { PermissionRequestInfo, SessionView } from '@claudeswitcher/core'

// Nem `require`-nek nevezzük: a CJS bundle modulburkolójában a `require` már
// paraméterként létezik, és egy azonos nevű `const` ütközne vele.
const requireNative = createRequire(import.meta.url)

const SW_RESTORE = 9
const GW_HWNDNEXT = 2

interface User32 {
  // Az `intptr` visszatérés koffi-ben futásidőben `number` vagy `bigint` lehet.
  GetTopWindow(hWnd: number): number | bigint
  GetWindow(hWnd: number, uCmd: number): number | bigint
  GetWindowThreadProcessId(hWnd: number, pid: [number]): number
  IsWindowVisible(hWnd: number): number
  GetWindowTextLengthW(hWnd: number): number
  GetForegroundWindow(): number | bigint
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

/** Az ablakbejáráshoz szükséges user32 részhalmaz, hogy tesztelhető legyen fake-kel. */
export type WindowScanner = Pick<
  User32,
  'GetTopWindow' | 'GetWindow' | 'GetWindowThreadProcessId' | 'IsWindowVisible' | 'GetWindowTextLengthW'
>

/**
 * A megadott processz látható, címmel rendelkező top-level ablakai, legfeljebb `cap` darab.
 *
 * Szándékosan a GetTopWindow + GetWindow láncot járjuk be, nem az EnumWindows-t:
 * az EnumWindows callbacket vár, amit koffi-ban regisztrálni kell, és a
 * regisztrált callback élettartama Electron main processzben könnyen elszáll.
 * A lánc bejárása ugyanazt adja, csak sima skalár hívásokkal.
 *
 * A `cap` miatt nem kell az egész asztalt végigjárni: a hívóknak csak az érdekes, hogy
 * nulla, egy, vagy több mint egy ablak van.
 */
export function scanWindowsForPid(api: WindowScanner, targetPid: number, cap = 2): number[] {
  const found: number[] = []
  const pidOut: [number] = [0]
  let hwnd = Number(api.GetTopWindow(0))

  for (let scanned = 0; hwnd !== 0 && scanned < MAX_WINDOWS_SCANNED; scanned++) {
    if (api.IsWindowVisible(hwnd) !== 0 && api.GetWindowTextLengthW(hwnd) > 0) {
      api.GetWindowThreadProcessId(hwnd, pidOut)
      if (pidOut[0] === targetPid) {
        found.push(hwnd)
        if (found.length >= cap) return found
      }
    }
    hwnd = Number(api.GetWindow(hwnd, GW_HWNDNEXT))
  }
  return found
}

/**
 * A megadott processz ablaka, DE csak ha pontosan egy van. Különben 0.
 *
 * Miért nem elég az első találat — lemérve ezen a gépen, nem feltételezve: egy VSCode
 * főprocessz az ÖSSZES ablakát birtokolja, és az `~/.claude/ide/*.lock` fájlokban egyetlen
 * pid 8–12 KÜLÖNBÖZŐ workspace mappához tartozik (a 24092-es pid tíz mappához, miközben
 * egyetlen ablaka van). A pid tehát nem azonosít ablakot. Az első Z-sorrendű találat a
 * LEGFELSŐ ablak lenne, nem a sessionhöz tartozó — vagyis az Enter egy másik projekt
 * ablakát hozná elő, és mivel a `SetForegroundWindow` sikeres, a `code -r` tartalék sem
 * futna le, ami helyesen találná meg.
 *
 * Egyértelműség nélkül ezért inkább nem választunk: a hívó a mappa alapján dolgozó
 * `code -r`-re esik vissza, ami a VSCode saját ablakfeloldását használja.
 */
export function findMainWindow(targetPid: number): number {
  const api = loadUser32()
  if (api === null) return 0
  const windows = scanWindowsForPid(api, targetPid)
  const only = windows[0]
  return windows.length === 1 && only !== undefined ? only : 0
}

/**
 * Ahány látható ablaka a processznek van, kettőnél megállva.
 *
 * Azért van külön a `findMainWindow`-tól, mert a live teszt ezzel tudja igazolni, hogy a
 * `GetWindowThreadProcessId` kimeneti paramétere tényleg ír — a `findMainWindow` egy több
 * ablakot birtokló processznél helyesen 0-t ad, ami ugyanúgy néz ki, mint egy nem működő
 * out-paraméter.
 */
export function countMainWindows(targetPid: number): number {
  const api = loadUser32()
  if (api === null) return 0
  return scanWindowsForPid(api, targetPid).length
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
 * Melyik úton jött elő az ablak. A tab-fókusznak ez kell, nem egy puszta „sikerült":
 * - `pid`: a gyors út, és az előtérbe került ablakot ellenőriztük (`foregroundWindow() === hwnd`);
 * - `workspace`: a `code -r` a lock fájl mappáját kapta, az ablakot a VSCode maga oldotta fel;
 * - `cwd`: a `code -r` a session cwd-jét kapta, mert a mappa ismeretlen. Ez egy VADONATÚJ
 *   ablakot is nyithatott, tehát nem tudjuk, hogy a session ablaka van-e elöl;
 * - `failed`: egyik út sem vezetett eredményre.
 */
export type FocusOutcome = 'pid' | 'workspace' | 'cwd' | 'failed'

/** A két fókuszlépés, hogy a `focusWith` sorrendje tesztelhető legyen ablak előhozása nélkül. */
export interface FocusSteps {
  byPid(pid: number): boolean
  byCli(folder: string): Promise<boolean>
}

/**
 * A `focusSessionWindow` döntési logikája, befecskendezett lépésekkel.
 *
 * Elsőként a lock fájlból ismert pid alapján, mert az azonnali — de csak akkor, ha annak a
 * pidnek pontosan egy ablaka van (lásd `findMainWindow`: egy VSCode főprocessz több ablakot
 * is birtokolhat, és ilyenkor a pid nem azonosít ablakot). Több ablak esetén, és ha a gyors
 * út bármiért nem vezet eredményre, a `code -r` dönt a mappa alapján.
 */
export async function focusWith(view: SessionView, steps: FocusSteps): Promise<FocusOutcome> {
  if (view.windowPid !== undefined && steps.byPid(view.windowPid)) return 'pid'
  if (view.workspaceFolder !== undefined) {
    return (await steps.byCli(view.workspaceFolder)) ? 'workspace' : 'failed'
  }
  return (await steps.byCli(view.cwd)) ? 'cwd' : 'failed'
}

/** Előtérbe hozza a session VSCode ablakát, és megmondja, melyik úton (lásd `FocusOutcome`). */
export function focusSessionWindow(view: SessionView): Promise<FocusOutcome> {
  return focusWith(view, { byPid: focusByPid, byCli: focusByCli })
}

/**
 * Ennyit várunk az ablak előhozása és a tab-fókusz URI között. A URI a legfelső, utoljára
 * aktív VSCode ablakhoz megy (a felhasználó mérése, 2026-10-21): a várakozás alatt a VSCode
 * feldolgozza a fókuszváltást, és a session ablakát jegyzi utoljára aktívnak — enélkül a URI
 * még az előző ablakhoz érkezhetne, ami egy új tabot nyitna. Rövid, mert a felhasználó vár rá.
 */
export const TAB_FOCUS_SETTLE_MS = 200

/** A VSCode bővítményben futó session registry-beli `entrypoint` értéke. */
const VSCODE_ENTRYPOINT = 'claude-vscode'

/** Egy kanonikus UUID (8-4-4-4-12 hexa). A Claude Code session azonosítói ilyenek. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A Claude Code bővítmény URI-ja, ami a session meglévő tabját hozza előre — vagy `undefined`,
 * ha nem biztonságos elküldeni. Tiszta függvény: a hívó csak elküldi, amit kap.
 *
 * A bővítmény a URI-t a legfelső VSCode ablakban kezeli, és ha abban nincs meg a session, egy
 * ÚJ tabot nyit neki. Ez soha nem történhet meg, ezért csak akkor küldjük, ha MIND igaz:
 * - az ablak előjött, és tudjuk, hogy a session ablaka: a `pid` út ellenőrizte az előtérbe
 *   került ablakot, a `workspace` úton a VSCode a lock fájl mappájából maga oldotta fel. A
 *   `cwd` út nem elég: a `code -r <cwd>` egy új ablakot nyithatott, és a URI ott a futó session
 *   egy másodpéldányát nyitná meg. `failed` esetén a legfelső ablak bármelyik lehet;
 * - a session ablaka ismert (`windowPid` vagy `workspaceFolder`) — a kimenettől függetlenül is,
 *   hogy egy ellentmondó kimenet se nyisson tabot;
 * - a session a VSCode bővítményben fut: egy CLI vagy terminál sessionre a bővítmény egy új
 *   tabot nyitna;
 * - az azonosító UUID: ellenőrizetlen szöveg nem kerül egy `openExternal`-lel megnyitott URL-be;
 * - a beállítás be van kapcsolva;
 * - a sessionnek nincs függő fájlírás-kérése (`edit` fajta, akár tartott, akár visszaengedett).
 *   Ilyenkor a VSCode a javasolt módosítást egy osztott diff tabon mutatja, és a natív kérdés
 *   is nyitva van; a URI a chat tabra váltana el a diffről, amit a felhasználó épp meg akar
 *   nézni (live teszt, 2026-10-22). Ekkor csak az ablak jön elő.
 */
export function tabFocusUri(
  view: SessionView,
  outcome: FocusOutcome,
  enabled: boolean,
  decisions: readonly Pick<PermissionRequestInfo, 'sessionId' | 'kind'>[],
): string | undefined {
  if (!enabled) return undefined
  if (decisions.some((d) => d.sessionId === view.sessionId && d.kind === 'edit')) return undefined
  if (outcome !== 'pid' && outcome !== 'workspace') return undefined
  if (view.windowPid === undefined && view.workspaceFolder === undefined) return undefined
  if (view.entrypoint !== VSCODE_ENTRYPOINT) return undefined
  if (!UUID.test(view.sessionId)) return undefined
  return `vscode://anthropic.claude-code/open?session=${encodeURIComponent(view.sessionId)}`
}
