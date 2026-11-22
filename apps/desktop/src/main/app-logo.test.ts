import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_ICON_SIZES, APP_LOGO_COLORS, appIconIco, appLogoPixels } from './app-logo.js'
import { decodePng } from './png-testing.js'
import { TRAY_COLORS } from './tray-icon.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const committedIco = (): Buffer => readFileSync(path.join(here, '../../resources/icon.ico'))

interface IcoImage {
  width: number
  height: number
  planes: number
  bitCount: number
  data: Buffer
}

/** Reads an ICO's directory and images (the ICONDIR and ICONDIRENTRY layout of the format). */
function readIco(bytes: Buffer): IcoImage[] {
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)
  const count = bytes.readUInt16LE(4)
  const images: IcoImage[] = []
  let expectedOffset = 6 + 16 * count
  for (let index = 0; index < count; index++) {
    const entry = 6 + 16 * index
    const length = bytes.readUInt32LE(entry + 8)
    const offset = bytes.readUInt32LE(entry + 12)
    // The images follow the directory one after the other, and the last one ends the file.
    expect(offset).toBe(expectedOffset)
    expectedOffset += length
    expect([bytes.readUInt8(entry + 2), bytes.readUInt8(entry + 3)]).toEqual([0, 0])
    images.push({
      width: bytes.readUInt8(entry) || 256,
      height: bytes.readUInt8(entry + 1) || 256,
      planes: bytes.readUInt16LE(entry + 4),
      bitCount: bytes.readUInt16LE(entry + 6),
      data: bytes.subarray(offset, offset + length),
    })
  }
  expect(expectedOffset).toBe(bytes.length)
  return images
}

/** An image's RGBA pixels, top row first: a PNG image decoded, or a 32-bit DIB read with its mask checked. */
function pixelsOf(image: IcoImage): Buffer {
  const size = image.width
  if (image.data.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) {
    const png = decodePng(image.data)
    expect([png.width, png.height]).toEqual([size, size])
    return png.pixels
  }
  const dib = image.data
  // BITMAPINFOHEADER: its size, the width, the doubled height, 1 plane, 32 bits, BI_RGB.
  expect([dib.readUInt32LE(0), dib.readInt32LE(4), dib.readInt32LE(8)]).toEqual([40, size, size * 2])
  expect([dib.readUInt16LE(12), dib.readUInt16LE(14), dib.readUInt32LE(16)]).toEqual([1, 32, 0])
  const maskStride = Math.ceil(size / 32) * 4
  expect(dib.length).toBe(40 + size * size * 4 + maskStride * size)
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row++) {
    const y = size - 1 - row
    for (let x = 0; x < size; x++) {
      const from = 40 + (row * size + x) * 4
      const [blue, green, red, alpha] = dib.subarray(from, from + 4)
      pixels.set([red!, green!, blue!, alpha!], (y * size + x) * 4)
      const masked = ((dib[40 + size * size * 4 + row * maskStride + (x >> 3)]! << (x & 7)) & 0x80) !== 0
      expect(masked).toBe(alpha === 0)
    }
  }
  return pixels
}

describe('resources/icon.ico', () => {
  it('is what the logo draws (run `node scripts/make-icon.mjs` after changing it)', () => {
    // Compared by what the images decode to, not byte for byte: the 256 px image is deflated, and
    // the compressed bytes are not promised to be the same across zlib builds.
    const committed = readIco(committedIco())
    const drawn = readIco(appIconIco())
    expect(committed.map(({ width, height, planes, bitCount }) => [width, height, planes, bitCount])).toEqual(
      drawn.map(({ width, height, planes, bitCount }) => [width, height, planes, bitCount]),
    )
    committed.forEach((image, index) => {
      expect(pixelsOf(image).equals(pixelsOf(drawn[index]!))).toBe(true)
    })
  })

  it('holds every Windows icon size, 32-bit, a PNG at 256 px and DIBs below', () => {
    const images = readIco(committedIco())
    expect(images.map(({ width, height }) => [width, height])).toEqual(APP_ICON_SIZES.map((size) => [size, size]))
    for (const image of images) {
      expect([image.planes, image.bitCount]).toEqual([1, 32])
      const isPng = image.data.subarray(1, 4).toString('latin1') === 'PNG'
      expect(isPng).toBe(image.width === 256)
      expect(pixelsOf(image).equals(appLogoPixels(image.width))).toBe(true)
    }
  })
})

describe('appLogoPixels', () => {
  const at = (pixels: Buffer, size: number, x: number, y: number): { color: string; alpha: number } => {
    const from = (y * size + x) * 4
    return { color: `#${pixels.subarray(from, from + 3).toString('hex')}`, alpha: pixels[from + 3]! }
  }
  const tile = { color: APP_LOGO_COLORS.tile, alpha: 0xff }
  const arrows = { color: APP_LOGO_COLORS.arrows, alpha: 0xff }

  it.each(APP_ICON_SIZES)('at %i px: a gold tile with rounded, transparent corners and a dark ⇄', (size) => {
    const pixels = appLogoPixels(size)
    const unit = size / 16
    const over = (x: number, y: number): { color: string; alpha: number } =>
      at(pixels, size, Math.floor(x * unit), Math.floor(y * unit))
    expect(at(pixels, size, 0, 0).alpha).toBe(0)
    expect(at(pixels, size, size - 1, size - 1).alpha).toBe(0)
    // The tile's edges, the middle between the arrows, the two shafts and the two heads, in units.
    expect(over(0.5, 8)).toEqual(tile)
    expect(over(8, 8)).toEqual(tile)
    expect(over(5, 5)).toEqual(arrows)
    expect(over(11, 11)).toEqual(arrows)
    expect(over(10, 5)).toEqual(arrows)
    expect(over(5, 11)).toEqual(arrows)
    // Above the top shaft and below the bottom one, outside the heads: the tile.
    expect(over(5, 3.5)).toEqual(tile)
    expect(over(11, 12.5)).toEqual(tile)
    // Fully covered pixels are the two colours; only edges blend them.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const pixel = at(pixels, size, x, y)
        const isEdge = pixel.color !== APP_LOGO_COLORS.tile && pixel.color !== APP_LOGO_COLORS.arrows
        if (pixel.alpha === 0xff && isEdge) {
          // A blend: every channel between the two colours.
          const parts = [pixel.color, APP_LOGO_COLORS.tile, APP_LOGO_COLORS.arrows].map((color) =>
            [1, 3, 5].map((from) => Number.parseInt(color.slice(from, from + 2), 16)),
          )
          parts[0]!.forEach((value, channel) => {
            expect(value).toBeGreaterThanOrEqual(Math.min(parts[1]![channel]!, parts[2]![channel]!))
            expect(value).toBeLessThanOrEqual(Math.max(parts[1]![channel]!, parts[2]![channel]!))
          })
        }
      }
    }
  })

  it('at 16 px draws the shafts in whole pixels', () => {
    const pixels = appLogoPixels(16)
    // The top shaft covers rows 4 and 5, the bottom one rows 10 and 11, with the tile around them.
    for (const y of [4, 5]) expect(at(pixels, 16, 5, y)).toEqual(arrows)
    for (const y of [3, 6]) expect(at(pixels, 16, 5, y)).toEqual(tile)
    for (const y of [10, 11]) expect(at(pixels, 16, 11, y)).toEqual(arrows)
    for (const y of [9, 12]) expect(at(pixels, 16, 11, y)).toEqual(tile)
  })

  it('is not the colour of a tray state', () => {
    expect(Object.values(TRAY_COLORS)).not.toContain(APP_LOGO_COLORS.tile)
  })
})
