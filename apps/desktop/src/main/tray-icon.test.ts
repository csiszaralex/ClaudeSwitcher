import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodePng } from './png-testing.js'
import { TRAY_COLORS, trayIconPixels, trayIconPng, trayIconSize, trayLook, type TrayLook } from './tray-icon.js'
import { IDLE_TRAY_STATE, type TrayState } from './tray-state.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The sizes at 100, 125, 150 and 200 % scaling. */
const SIZES = [16, 20, 24, 32] as const
/** The icon's units: the shapes below are described in them, as in `tray-icon.ts`. */
const UNITS = 16
const CENTER = UNITS / 2

interface Pixel {
  color: string
  alpha: number
}

/** The pixel at (x, y): its colour as `#rrggbb` and its alpha. */
function pixelAt(pixels: Buffer, size: number, x: number, y: number): Pixel {
  const at = (y * size + x) * 4
  return { color: `#${pixels.subarray(at, at + 3).toString('hex')}`, alpha: pixels[at + 3]! }
}

/** The pixel that contains the point (x, y), given in units. */
function pixelOver(pixels: Buffer, size: number, x: number, y: number): Pixel {
  const scale = size / UNITS
  return pixelAt(pixels, size, Math.floor(x * scale), Math.floor(y * scale))
}

/** Every pixel with its nearest and farthest distance from the icon's centre, in units. */
function* everyPixel(size: number): Generator<{ x: number; y: number; nearest: number; farthest: number }> {
  const unit = UNITS / size
  const axis = (from: number): [number, number] => {
    const low = from * unit - CENTER
    const high = low + unit
    const nearest = low <= 0 && high >= 0 ? 0 : Math.min(Math.abs(low), Math.abs(high))
    return [nearest, Math.max(Math.abs(low), Math.abs(high))]
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [nearX, farX] = axis(x)
      const [nearY, farY] = axis(y)
      yield { x, y, nearest: Math.hypot(nearX, nearY), farthest: Math.hypot(farX, farY) }
    }
  }
}

/** A `#rrggbb` colour's red, green and blue. */
function channels(color: string): number[] {
  return [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16))
}

/** The colours of the fully covered pixels of a look. */
function opaqueColors(look: TrayLook, size: number): Set<string> {
  const pixels = trayIconPixels(look, size)
  const colors = new Set<string>()
  for (const { x, y } of everyPixel(size)) {
    const pixel = pixelAt(pixels, size, x, y)
    if (pixel.alpha === 0xff) colors.add(pixel.color)
  }
  return colors
}

/** A tray state: idle unless the test says otherwise. */
const state = (overrides: Partial<TrayState> = {}): TrayState => ({ ...IDLE_TRAY_STATE, ...overrides })
const calm = state({ waitingCount: 1, wait: 'yes-no' })

describe('trayLook', () => {
  it('fills the disc with the colour of what waits', () => {
    expect(trayLook(IDLE_TRAY_STATE, false)).toEqual({ fill: TRAY_COLORS.idle })
    expect(trayLook(state({ waitingCount: 1, wait: 'yes-no' }), false)).toEqual({ fill: TRAY_COLORS.yesNo })
    expect(trayLook(state({ waitingCount: 1, wait: 'choice' }), false)).toEqual({ fill: TRAY_COLORS.choice })
    expect(trayLook(state({ waitingCount: 1, wait: 'released' }), false)).toEqual({ fill: TRAY_COLORS.released })
  })

  it('turns green for an unseen finish while nothing waits', () => {
    expect(trayLook(state({ finishedCount: 1 }), false)).toEqual({ fill: TRAY_COLORS.done })
  })

  it('turns blue for a working session while nothing waits and no finish is unseen', () => {
    expect(trayLook(state({ workingCount: 1 }), false)).toEqual({ fill: TRAY_COLORS.working })
  })

  it('keeps an unseen finish over a working session, without a ring', () => {
    expect(trayLook(state({ finishedCount: 1, workingCount: 2 }), false)).toEqual({ fill: TRAY_COLORS.done })
  })

  it('keeps what waits over a working session, a released request included', () => {
    expect(trayLook(state({ waitingCount: 1, wait: 'yes-no', workingCount: 1 }), false)).toEqual({ fill: TRAY_COLORS.yesNo })
    expect(trayLook(state({ waitingCount: 1, wait: 'released', workingCount: 1 }), false)).toEqual({
      fill: TRAY_COLORS.released,
    })
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
    expect(trayLook(state({ waitingCount: 1, wait: 'yes-no', finishedCount: 2 }), false)).toEqual({
      fill: TRAY_COLORS.yesNo,
      ring: TRAY_COLORS.done,
    })
    expect(trayLook(state({ waitingCount: 1, wait: 'choice', finishedCount: 1 }), false)).toEqual({
      fill: TRAY_COLORS.choice,
      ring: TRAY_COLORS.done,
    })
    expect(trayLook(state({ waitingCount: 1, wait: 'released', finishedCount: 1 }), false)).toEqual({
      fill: TRAY_COLORS.released,
      ring: TRAY_COLORS.done,
    })
  })
})

describe('trayIconSize', () => {
  it('gives the pixels for the display scale, so Windows does not scale the icon', () => {
    expect([1, 1.25, 1.5, 2].map(trayIconSize)).toEqual([...SIZES])
  })
})

describe('trayIconPixels', () => {
  const plainFills = [
    TRAY_COLORS.idle,
    TRAY_COLORS.yesNo,
    TRAY_COLORS.choice,
    TRAY_COLORS.released,
    TRAY_COLORS.done,
    TRAY_COLORS.working,
  ]

  it.each(SIZES)('is a %i px square of RGBA pixels', (size) => {
    expect(trayIconPixels({ fill: TRAY_COLORS.yesNo }, size).length).toBe(size * size * 4)
  })

  it.each(SIZES)('at %i px: draws the disc in one colour, edges only fading, transparent outside', (size) => {
    for (const fill of plainFills) {
      const pixels = trayIconPixels({ fill }, size)
      for (const { x, y, nearest, farthest } of everyPixel(size)) {
        const pixel = pixelAt(pixels, size, x, y)
        // Outside the disc (radius 6 units): transparent. Inside it: fully covered.
        if (nearest >= 6) expect(pixel.alpha).toBe(0)
        else if (farthest <= 6) expect(pixel.alpha).toBe(0xff)
        // Every pixel drawn at all is the fill colour, the edge's only by a lower alpha.
        if (pixel.alpha > 0) expect(pixel.color).toBe(fill)
      }
    }
  })

  it.each(SIZES)('at %i px: draws a ring around a centre with a transparent gap between', (size) => {
    const look = { fill: TRAY_COLORS.choice, ring: TRAY_COLORS.done }
    const pixels = trayIconPixels(look, size)
    // Along the middle row, from the left: the ring (radius 5 to 6), the gap (4 to 5), the centre.
    const ring = pixelOver(pixels, size, CENTER - 5.5, CENTER)
    expect(ring.color).toBe(TRAY_COLORS.done)
    expect(ring.alpha).toBeGreaterThanOrEqual(0x80)
    // At 16 px the gap's pixel touches the ring's corner a little (alpha 8); never more than that.
    expect(pixelOver(pixels, size, CENTER - 4.5, CENTER).alpha).toBeLessThanOrEqual(0x10)
    expect(pixelOver(pixels, size, CENTER - 3, CENTER)).toEqual({ color: TRAY_COLORS.choice, alpha: 0xff })
    expect(pixelOver(pixels, size, CENTER + 4.5, CENTER).alpha).toBeLessThanOrEqual(0x10)
    expect(pixelOver(pixels, size, CENTER + 5.5, CENTER).color).toBe(TRAY_COLORS.done)
    // The 1 unit ring has no fully covered pixel at 16 and 20 px, so this is a subset check.
    for (const color of opaqueColors(look, size)) expect([TRAY_COLORS.choice, TRAY_COLORS.done]).toContain(color)
  })

  it.each(SIZES)('at %i px: draws the flash frame as a red disc with a white exclamation mark', (size) => {
    const look = { fill: TRAY_COLORS.flash, mark: true }
    const pixels = trayIconPixels(look, size)
    const white = { color: TRAY_COLORS.mark, alpha: 0xff }
    // The bar (units 3 to 10), the gap (10 to 11) and the dot (11 to 13), in the middle columns.
    expect(pixelOver(pixels, size, CENTER, 4)).toEqual(white)
    expect(pixelOver(pixels, size, CENTER, 9)).toEqual(white)
    // The gap is 1 unit, snapped to at least one whole red pixel at every size.
    expect(pixelOver(pixels, size, CENTER, 10.5)).toEqual({ color: TRAY_COLORS.flash, alpha: 0xff })
    expect(pixelOver(pixels, size, CENTER, 12)).toEqual(white)
    expect(pixelOver(pixels, size, 4, CENTER)).toEqual({ color: TRAY_COLORS.flash, alpha: 0xff })
    // Every drawn pixel is the red, the white or a mix of the two (the mark's edges).
    const [fillRgb, markRgb] = [TRAY_COLORS.flash, TRAY_COLORS.mark].map(channels)
    for (const { x, y } of everyPixel(size)) {
      const pixel = pixelAt(pixels, size, x, y)
      if (pixel.alpha === 0) continue
      channels(pixel.color).forEach((value, channel) => {
        expect(value).toBeGreaterThanOrEqual(Math.min(fillRgb![channel]!, markRgb![channel]!))
        expect(value).toBeLessThanOrEqual(Math.max(fillRgb![channel]!, markRgb![channel]!))
      })
    }
  })

  it.each(SIZES)('at %i px: draws the mark in whole pixels, never blended into the red', (size) => {
    // Only the disc's rim is anti-aliased: every pixel inside it is exactly the red or the white.
    const pixels = trayIconPixels({ fill: TRAY_COLORS.flash, mark: true }, size)
    for (const { x, y } of everyPixel(size)) {
      const pixel = pixelAt(pixels, size, x, y)
      if (pixel.alpha === 0xff) expect([TRAY_COLORS.flash, TRAY_COLORS.mark]).toContain(pixel.color)
    }
  })

  it('at 16 px draws the mark in whole pixels, as before the icons were anti-aliased', () => {
    const pixels = trayIconPixels({ fill: TRAY_COLORS.flash, mark: true }, 16)
    const markRows = [3, 4, 5, 6, 7, 8, 9, 11, 12]
    for (const { x, y } of everyPixel(16)) {
      const onMark = (x === 7 || x === 8) && markRows.includes(y)
      expect(pixelAt(pixels, 16, x, y).color === TRAY_COLORS.mark).toBe(onMark)
    }
  })
})

describe('trayIconPng', () => {
  it.each(SIZES)('encodes exactly the drawn pixels at %i px', (size) => {
    const look = { fill: TRAY_COLORS.choice, ring: TRAY_COLORS.done }
    const png = decodePng(trayIconPng(look, size))
    expect([png.width, png.height]).toEqual([size, size])
    expect(png.pixels.equals(trayIconPixels(look, size))).toBe(true)
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
    ['released', '--warning'],
    ['done', '--success'],
    ['working', '--info'],
    ['flash', '--danger'],
  ] as const)('%s equals the list colour %s', (key, variable) => {
    expect(cssVariable(variable)).toBe(TRAY_COLORS[key])
  })
})
