import { exec, execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  findMainWindow,
  foregroundWindow,
  isFastFocusAvailable,
  isSafeForCli,
  quoteForCli,
} from './focus-window.js'

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
    const pid = runningVSCodeWindowPid()
    if (pid === undefined) {
      // Látható kihagyás, nem csendes átmenet: a futtatás kimenetében látszania kell.
      ctx.skip()
      return
    }
    expect(findMainWindow(pid)).toBeGreaterThan(0)
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
