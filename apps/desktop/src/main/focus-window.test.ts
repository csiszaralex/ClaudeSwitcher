import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { findMainWindow, foregroundWindow, isSafeForCli } from './focus-window.js'

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
  it.skipIf(!onWindows)('reads the foreground handle as a plain number without changing it', () => {
    // A focusByPid ezzel ellenőrzi, hogy a fókuszváltás ténylegesen megtörtént-e. A
    // teszt csak olvas. Nem követel nullánál nagyobb értéket: zárolt képernyőn vagy
    // fókuszváltás közben a Windows jogosan adhat 0-t.
    const hwnd = foregroundWindow()
    expect(typeof hwnd).toBe('number')
    expect(Number.isFinite(hwnd)).toBe(true)
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
