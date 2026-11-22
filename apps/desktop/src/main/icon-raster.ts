import { crc32, deflateSync } from 'node:zlib'

// Draws an icon from a description of its shapes and encodes it as a PNG, with `node:zlib` only.
// The tray icons (`tray-icon.ts`) draw with it.

/**
 * The colour at a point of the icon, in the icon's own units (`0` to `units` on both axes, x to the
 * right, y down), as `#rrggbb`; `undefined` where the icon is transparent.
 */
export type IconPaint = (x: number, y: number) => string | undefined

/**
 * Samples per pixel along each axis. Each pixel takes the colours of SAMPLES x SAMPLES points spread
 * evenly over it: the share of the points that hit a shape is the pixel's coverage (its alpha), so
 * edges come out anti-aliased. An edge on a pixel boundary covers exactly 0 or all of the points, so
 * shapes that line up with the pixel grid stay as sharp as pixel art.
 */
const SAMPLES = 8

const BYTES_PER_PIXEL = 4

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * The icon as `size` x `size` RGBA pixels, row by row, with straight (not premultiplied) alpha: the
 * alpha is the pixel's coverage, the colour the average of the points that hit, so an edge pixel
 * keeps the shape's colour and only fades. Transparent pixels are all zero. `units` is how many of
 * `paint`'s units the icon is wide; every size is drawn from the same description.
 */
export function rasterizeIcon(size: number, units: number, paint: IconPaint): Buffer {
  const pixels = Buffer.alloc(size * size * BYTES_PER_PIXEL)
  const unitsPerSample = units / (size * SAMPLES)
  const parsed = new Map<string, [number, number, number]>()
  const colorOf = (hex: string): [number, number, number] => {
    let value = parsed.get(hex)
    if (value === undefined) {
      value = rgb(hex)
      parsed.set(hex, value)
    }
    return value
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        const y = (py * SAMPLES + sy + 0.5) * unitsPerSample
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = paint((px * SAMPLES + sx + 0.5) * unitsPerSample, y)
          if (color === undefined) continue
          const [r, g, b] = colorOf(color)
          hits++
          red += r
          green += g
          blue += b
        }
      }
      if (hits === 0) continue
      const alpha = Math.round((hits * 0xff) / (SAMPLES * SAMPLES))
      pixels.set(
        [Math.round(red / hits), Math.round(green / hits), Math.round(blue / hits), alpha],
        (py * size + px) * BYTES_PER_PIXEL,
      )
    }
  }
  return pixels
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * Square RGBA pixels (`rasterizeIcon`) as a PNG file in memory: 8-bit RGBA, no interlacing, filter 0
 * on every line. A PNG, not raw pixels for `nativeImage.createFromBitmap`: Electron documents the
 * bitmap's byte order as platform-dependent, a PNG's is fixed.
 */
export function encodePng(size: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  // Bit depth 8, colour type 6 (RGBA), compression 0, filter 0, no interlacing.
  header.set([8, 6, 0, 0, 0], 8)
  const stride = size * BYTES_PER_PIXEL
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    // The filter byte of each line stays 0 (none).
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
