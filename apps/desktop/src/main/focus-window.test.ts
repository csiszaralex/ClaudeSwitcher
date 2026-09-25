import { exec, execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  countMainWindows,
  findMainWindow,
  foregroundWindow,
  isFastFocusAvailable,
  isSafeForCli,
  quoteForCli,
  scanWindowsForPid,
  type WindowScanner,
} from './focus-window.js'

/** Egy hamis asztal: a megadott ablakok Z-sorrendben, láncba kötve. */
function fakeScanner(
  windows: Array<{ hwnd: number; pid: number; visible?: boolean; titled?: boolean }>,
): WindowScanner {
  const byHwnd = new Map(windows.map((w) => [w.hwnd, w]))
  const order = windows.map((w) => w.hwnd)
  return {
    GetTopWindow: () => order[0] ?? 0,
    GetWindow: (hWnd: number) => {
      const index = order.indexOf(hWnd)
      return index === -1 ? 0 : (order[index + 1] ?? 0)
    },
    GetWindowThreadProcessId: (hWnd: number, pid: [number]) => {
      pid[0] = byHwnd.get(hWnd)?.pid ?? 0
      return 0
    },
    IsWindowVisible: (hWnd: number) => (byHwnd.get(hWnd)?.visible === false ? 0 : 1),
    GetWindowTextLengthW: (hWnd: number) => (byHwnd.get(hWnd)?.titled === false ? 0 : 5),
  }
}

const onWindows = process.platform === 'win32'

/** Egy futó, látható főablakkal rendelkező VSCode processz pidje, vagy undefined. */
function runningVSCodeWindowPid(): number | undefined {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process Code -ErrorAction SilentlyContinue | ' +
        'Where-Object { $_.MainWindowHandle -ne 0 } | ' +
        'Select-Object -First 1 -ExpandProperty Id',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  ).trim()
  const pid = Number.parseInt(out, 10)
  return Number.isNaN(pid) ? undefined : pid
}

describe('findMainWindow', () => {
  it.skipIf(!onWindows)('loads the koffi bindings and returns 0 for a pid owning no window', () => {
    // Bizonyítja, hogy a user32 kötések betöltődnek a deklarált szignatúrákkal, és
    // hogy a bejáró ciklus leáll. FIGYELEM: önmagában NEM bizonyítja, hogy a
    // GetWindowThreadProcessId kimeneti paramétere működik — ha a pid sosem íródna
    // ki, ez a teszt akkor is 0-t kapna és átmenne. Azt a harmadik teszt fedi.
    expect(findMainWindow(999_999_998)).toBe(0)
  })

  it.skipIf(!onWindows)('returns a plain number rather than a BigInt', () => {
    // Egy BigInt HWND-vel a `hwnd !== 0` sosem lenne hamis.
    expect(typeof findMainWindow(999_999_998)).toBe('number')
  })

  it.skipIf(!onWindows)('finds the main window of a running VSCode instance', (ctx) => {
    // Ez az a teszt, ami ténylegesen igazolja a kimeneti paramétert: nullánál
    // nagyobb értéket csak akkor kaphatunk, ha a GetWindowThreadProcessId kiírta a
    // pidet, és az egyezett. Ablakot NEM hoz előtérbe — csak megkeresi.
    //
    // A `countMainWindows`-t használja, nem a `findMainWindow`-t: utóbbi egy több ablakot
    // birtokló processznél helyesen 0-t ad, ami megkülönböztethetetlen lenne egy nem
    // működő out-paramétertől — vagyis a teszt pont azt nem bizonyítaná, amiért létezik.
    const pid = runningVSCodeWindowPid()
    if (pid === undefined) {
      // Látható kihagyás, nem csendes átmenet: a futtatás kimenetében látszania kell.
      ctx.skip()
      return
    }
    expect(countMainWindows(pid)).toBeGreaterThan(0)
  })
})

describe('scanWindowsForPid', () => {
  it('returns the one window a process owns', () => {
    const api = fakeScanner([
      { hwnd: 10, pid: 111 },
      { hwnd: 20, pid: 222 },
    ])
    expect(scanWindowsForPid(api, 222)).toEqual([20])
  })

  it('reports more than one window, so an ambiguous pid can be detected', () => {
    // Ez a valódi eset: egy VSCode főprocessz az összes ablakát birtokolja, és egy
    // lock-pid több workspace mappához tartozik. Ilyenkor a pid nem azonosít ablakot.
    const api = fakeScanner([
      { hwnd: 10, pid: 777 },
      { hwnd: 20, pid: 999 },
      { hwnd: 30, pid: 777 },
    ])
    expect(scanWindowsForPid(api, 777)).toHaveLength(2)
  })

  it('ignores invisible and untitled windows', () => {
    const api = fakeScanner([
      { hwnd: 10, pid: 555, visible: false },
      { hwnd: 20, pid: 555, titled: false },
      { hwnd: 30, pid: 555 },
    ])
    expect(scanWindowsForPid(api, 555)).toEqual([30])
  })

  it('returns nothing for a pid that owns no window', () => {
    expect(scanWindowsForPid(fakeScanner([{ hwnd: 10, pid: 111 }]), 222)).toEqual([])
  })
})

describe('foregroundWindow', () => {
  it.skipIf(!onWindows)('reads the foreground handle through loaded bindings, without changing it', () => {
    // A focusByPid ezzel ellenőrzi, hogy a fókuszváltás ténylegesen megtörtént-e.
    // Az isFastFocusAvailable nélkül ez a teszt akkor is átmenne, ha a kötések el sem
    // töltődtek — a foregroundWindow ilyenkor 0-t ad, ami szintén véges szám. A
    // teszt csak olvas; nullánál nagyobb értéket nem követel, mert zárolt képernyőn
    // vagy fókuszváltás közben a Windows jogosan adhat 0-t.
    expect(isFastFocusAvailable()).toBe(true)
    const hwnd = foregroundWindow()
    expect(typeof hwnd).toBe('number')
    expect(Number.isFinite(hwnd)).toBe(true)
  })
})

describe('quoteForCli', () => {
  /** Átküldi az idézett tokent a valódi cmd.exe + CRT argv láncon, és visszaolvassa. */
  function roundTrip(folder: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        `node -e "process.stdout.write(process.argv[1])" ${quoteForCli(folder)}`,
        { windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
    })
  }

  it.skipIf(!onWindows)('survives the real CRT argv parser unchanged', async () => {
    // Nem a string alakját állítja, hanem hogy a valódi feldolgozó ugyanazt adja
    // vissza. A javítás előtti sima idézés ezek közül négyet elrontott.
    const folders = [
      'C:\\work\\normal-folder',
      'C:\\',
      'C:\\work\\trailing\\',
      'C:\\work\\double\\\\',
      '\\\\server\\share\\',
      'C:\\My Projects\\R&D (old)',
    ]
    for (const folder of folders) {
      expect(await roundTrip(folder)).toBe(folder)
    }
  })
})

describe('isSafeForCli', () => {
  it('accepts ordinary folders, including spaces, ampersands and parentheses', () => {
    expect(isSafeForCli('p:\\08_Apps\\ClaudeSwitcher')).toBe(true)
    expect(isSafeForCli('C:\\My Projects\\R&D (old)')).toBe(true)
  })

  it('rejects folders cmd.exe would reinterpret even inside quotes', () => {
    // A `%TEMP%` a review mérése szerint csendben egy MÁSIK útvonalra bontódik ki.
    expect(isSafeForCli('C:\\work\\%TEMP%')).toBe(false)
    expect(isSafeForCli('C:\\work\\a"b')).toBe(false)
  })
})
