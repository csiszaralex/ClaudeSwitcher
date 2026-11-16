import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TRAY_COLORS, TRAY_ICON_SIZE, trayIconPixels, trayIconPng, trayLook, type TrayLook } from './tray-icon.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * Decodes the only PNG shape this test meets: 8-bit RGBA, no interlacing, filter 0 on every line
 * (what `trayIconPng` writes and what `resources/tray.png` is). Anything else fails the test.
 */
function decodePng(bytes: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  const idat: Buffer[] = []
  let width = 0
  let height = 0
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0])
    }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0)
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels }
}

/** The pixel at (x, y) as `#rrggbb`, or `transparent`. */
function colorAt(pixels: Buffer, x: number, y: number): string {
  const at = (y * TRAY_ICON_SIZE + x) * 4
  if (pixels[at + 3] === 0) return 'transparent'
  expect(pixels[at + 3]).toBe(0xff)
  return `#${pixels.subarray(at, at + 3).toString('hex')}`
}

/** Every opaque colour of a look, so a test can see that nothing else is drawn. */
function colorsOf(look: TrayLook): Set<string> {
  const pixels = trayIconPixels(look)
  const colors = new Set<string>()
  for (let y = 0; y < TRAY_ICON_SIZE; y++) for (let x = 0; x < TRAY_ICON_SIZE; x++) colors.add(colorAt(pixels, x, y))
  colors.delete('transparent')
  return colors
}

const MIDDLE = TRAY_ICON_SIZE / 2
const calm = { waitingCount: 1, wait: 'yes-no', finishedCount: 0, flash: false } as const

describe('trayLook', () => {
  it('fills the disc with the colour of what waits', () => {
    expect(trayLook({ waitingCount: 0, wait: 'none', finishedCount: 0, flash: false }, false)).toEqual({ fill: TRAY_COLORS.idle })
    expect(trayLook({ waitingCount: 1, wait: 'yes-no', finishedCount: 0, flash: false }, false)).toEqual({ fill: TRAY_COLORS.yesNo })
    expect(trayLook({ waitingCount: 1, wait: 'choice', finishedCount: 0, flash: false }, false)).toEqual({ fill: TRAY_COLORS.choice })
  })

  it('turns green for an unseen finish while nothing waits', () => {
    expect(trayLook({ waitingCount: 0, wait: 'none', finishedCount: 1, flash: false }, false)).toEqual({ fill: TRAY_COLORS.done })
  })

  it('alternates the flash frame with the normal icon while the state flashes', () => {
    const flashing = { ...calm, finishedCount: 1, flash: true }
    const flashFrame = trayLook(flashing, true)
    expect(flashFrame).toEqual({ fill: TRAY_COLORS.flash, mark: true })
    expect(trayLook(flashing, false)).toEqual({ fill: TRAY_COLORS.yesNo, ring: TRAY_COLORS.done })
  })

  it('never shows the flash frame without a flash', () => {
    expect(trayLook(calm, true)).toEqual({ fill: TRAY_COLORS.yesNo })
  })

  it('puts a green ring around what waits when a finish is unseen too', () => {
    expect(trayLook({ waitingCount: 1, wait: 'yes-no', finishedCount: 2, flash: false }, false)).toEqual({
      fill: TRAY_COLORS.yesNo,
      ring: TRAY_COLORS.done,
    })
    expect(trayLook({ waitingCount: 1, wait: 'choice', finishedCount: 1, flash: false }, false)).toEqual({
      fill: TRAY_COLORS.choice,
      ring: TRAY_COLORS.done,
    })
  })
})

describe('trayIconPixels', () => {
  it('is a 16x16 RGBA image with transparent corners', () => {
    const pixels = trayIconPixels({ fill: TRAY_COLORS.yesNo })
    expect(pixels.length).toBe(TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4)
    expect(colorAt(pixels, 0, 0)).toBe('transparent')
    expect(colorAt(pixels, TRAY_ICON_SIZE - 1, TRAY_ICON_SIZE - 1)).toBe('transparent')
  })

  it('draws a plain disc in one colour, edge and centre alike', () => {
    for (const fill of [TRAY_COLORS.idle, TRAY_COLORS.yesNo, TRAY_COLORS.choice, TRAY_COLORS.done]) {
      const pixels = trayIconPixels({ fill })
      expect(colorAt(pixels, MIDDLE, MIDDLE)).toBe(fill)
      expect(colorAt(pixels, 2, MIDDLE)).toBe(fill)
      expect(colorsOf({ fill })).toEqual(new Set([fill]))
    }
  })

  it('draws a ring in the ring colour around a centre in the fill colour, with a gap between', () => {
    const look = { fill: TRAY_COLORS.choice, ring: TRAY_COLORS.done }
    const pixels = trayIconPixels(look)
    expect(colorAt(pixels, MIDDLE, MIDDLE)).toBe(TRAY_COLORS.choice)
    // Along the middle row, from the left edge of the disc: ring (x 2, 3), gap (x 4), centre (x 5).
    expect(colorAt(pixels, 2, MIDDLE)).toBe(TRAY_COLORS.done)
    expect(colorAt(pixels, 3, MIDDLE)).toBe(TRAY_COLORS.done)
    expect(colorAt(pixels, 4, MIDDLE)).toBe('transparent')
    expect(colorAt(pixels, 5, MIDDLE)).toBe(TRAY_COLORS.choice)
    expect(colorsOf(look)).toEqual(new Set([TRAY_COLORS.choice, TRAY_COLORS.done]))
  })

  it('draws the flash frame as a red disc with a white exclamation mark', () => {
    const look = { fill: TRAY_COLORS.flash, mark: true }
    const pixels = trayIconPixels(look)
    // The bar (rows 3 to 9) and the dot (rows 11, 12) in the two middle columns, a gap at row 10.
    for (const y of [3, 9, 11, 12]) expect(colorAt(pixels, MIDDLE, y)).toBe(TRAY_COLORS.mark)
    expect(colorAt(pixels, MIDDLE, 10)).toBe(TRAY_COLORS.flash)
    expect(colorAt(pixels, 2, MIDDLE)).toBe(TRAY_COLORS.flash)
    expect(colorsOf(look)).toEqual(new Set([TRAY_COLORS.flash, TRAY_COLORS.mark]))
  })

  it('draws the idle icon exactly as resources/tray.png, the source of the app icon', () => {
    const png = decodePng(readFileSync(path.join(here, '../../resources/tray.png')))
    expect([png.width, png.height]).toEqual([TRAY_ICON_SIZE, TRAY_ICON_SIZE])
    const drawn = trayIconPixels({ fill: TRAY_COLORS.idle })
    for (let y = 0; y < TRAY_ICON_SIZE; y++) {
      for (let x = 0; x < TRAY_ICON_SIZE; x++) expect(colorAt(drawn, x, y)).toBe(colorAt(png.pixels, x, y))
    }
  })
})

describe('trayIconPng', () => {
  it('encodes exactly the drawn pixels', () => {
    const look = { fill: TRAY_COLORS.choice }
    const png = decodePng(trayIconPng(look))
    expect([png.width, png.height]).toEqual([TRAY_ICON_SIZE, TRAY_ICON_SIZE])
    expect(png.pixels.equals(trayIconPixels(look))).toBe(true)
  })
})

describe('TRAY_COLORS', () => {
  // The list and the tray show the same state in the same colour; each value has its home in its
  // own file, so this checks that they agree (as app-id.test.ts does for the appId).
  const css = readFileSync(path.join(here, '../renderer/styles.css'), 'utf8')
  const cssVariable = (name: string): string | undefined =>
    new RegExp(`^\\s*${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'im').exec(css)?.[1]?.toLowerCase()

  it.each([
    ['yesNo', '--accent'],
    ['choice', '--choice'],
    ['done', '--success'],
    ['flash', '--danger'],
  ] as const)('%s equals the list colour %s', (key, variable) => {
    expect(cssVariable(variable)).toBe(TRAY_COLORS[key])
  })
})
