import { encodePng, rasterizeIcon, type IconPaint } from './icon-raster.js'

// The app's logo: a gold rounded square with a dark ⇄, two opposite arrows, the sign of switching.
// Only `scripts/make-icon.mjs` draws it, into `resources/icon.ico`, the icon electron-builder puts on
// the exe and the installer; `app-logo.test.ts` checks that the committed file is what it draws.

/**
 * The logo's colours, `#rrggbb`: their one home. The tile is a warm gold, deliberately not the
 * tray's lemon (`tray-icon.ts` `TRAY_COLORS.released`), so the logo is never taken for that state.
 * The arrows are the overlay's dark background (`--bg` in `renderer/styles.css`) by choice, not by
 * reference: the logo is a fixed picture, a change of the theme does not redraw it.
 */
export const APP_LOGO_COLORS = {
  tile: '#f2a33a',
  arrows: '#1c1b1a',
} as const

/** The sizes the icon file holds: every size Windows shows an app icon at (16 to 256 px). */
export const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const

/** The logo is described in 16 units, the smallest size, so its shapes are checked where it is tightest. */
const UNITS = 16

/** The tile fills the whole square; its corners are rounded with this radius. */
const TILE_CORNER_RADIUS = 3.5

/**
 * An arrow: a shaft 2 units thick and a triangular head 4 units long and 6 units high. Its edges are
 * on whole units where they are straight, so at 16 px the shafts are whole pixels.
 */
const SHAFT_HALF_THICKNESS = 1
const HEAD_LENGTH = 4
const HEAD_HALF_HEIGHT = 3

/** The top arrow points right, the bottom one left: their axes, tips and tails, in units. */
const TOP_ARROW = { axisY: 5, tipX: 13, tailX: 3 } as const
const BOTTOM_ARROW = { axisY: 11, tipX: 3, tailX: 13 } as const

function insideTile(x: number, y: number): boolean {
  // The distance from the nearest corner's centre, where the point lies in a corner square.
  const cornerX = Math.max(TILE_CORNER_RADIUS - x, x - (UNITS - TILE_CORNER_RADIUS), 0)
  const cornerY = Math.max(TILE_CORNER_RADIUS - y, y - (UNITS - TILE_CORNER_RADIUS), 0)
  return x >= 0 && x <= UNITS && y >= 0 && y <= UNITS && Math.hypot(cornerX, cornerY) <= TILE_CORNER_RADIUS
}

function onArrow(arrow: { axisY: number; tipX: number; tailX: number }, x: number, y: number): boolean {
  const direction = Math.sign(arrow.tipX - arrow.tailX)
  // How far the point is behind the tip, along the arrow.
  const behindTip = (arrow.tipX - x) * direction
  const behindTail = (arrow.tailX - x) * direction
  if (behindTip < 0 || behindTail > 0) return false
  const offAxis = Math.abs(y - arrow.axisY)
  if (behindTip <= HEAD_LENGTH) return offAxis <= (HEAD_HALF_HEIGHT * behindTip) / HEAD_LENGTH
  return offAxis <= SHAFT_HALF_THICKNESS
}

const paint: IconPaint = (x, y) => {
  if (!insideTile(x, y)) return undefined
  return onArrow(TOP_ARROW, x, y) || onArrow(BOTTOM_ARROW, x, y) ? APP_LOGO_COLORS.arrows : APP_LOGO_COLORS.tile
}

/** The logo as `size` x `size` RGBA pixels (`rasterizeIcon`); every size is the same drawing. */
export function appLogoPixels(size: number): Buffer {
  return rasterizeIcon(size, UNITS, paint)
}

const ICONDIR_BYTES = 6
const ICONDIRENTRY_BYTES = 16
const BITMAPINFOHEADER_BYTES = 40

/**
 * One image of the icon file as a DIB: a BITMAPINFOHEADER with the height doubled, the BGRA pixels
 * bottom-up, then the 1-bit AND mask (set where the pixel is transparent), its rows padded to 4 bytes.
 */
function dibEntry(size: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(BITMAPINFOHEADER_BYTES)
  const maskStride = Math.ceil(size / 32) * 4
  header.writeUInt32LE(BITMAPINFOHEADER_BYTES, 0)
  header.writeInt32LE(size, 4)
  // The colour image and the AND mask, one above the other.
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  // BI_RGB, then the image size; the resolution and colour table fields stay 0.
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4 + maskStride * size, 20)
  const color = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(maskStride * size)
  for (let row = 0; row < size; row++) {
    // A DIB with a positive height stores its bottom row first.
    const y = size - 1 - row
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = (row * size + x) * 4
      color.set([pixels[from + 2] ?? 0, pixels[from + 1] ?? 0, pixels[from] ?? 0, pixels[from + 3] ?? 0], to)
      const maskByte = row * maskStride + (x >> 3)
      if (pixels[from + 3] === 0) mask[maskByte] = (mask[maskByte] ?? 0) | (0x80 >> (x & 7))
    }
  }
  return Buffer.concat([header, color, mask])
}

/**
 * The icon file: an ICONDIR, one ICONDIRENTRY per size, then the images. The 256 px image is a PNG,
 * the smaller ones DIBs, as Microsoft recommends for 32-bit icons (PNG images need Windows Vista or
 * later, and the DIBs keep every reader of the smaller sizes working). A width or height of 256 is
 * written as 0. Deterministic: the same code gives the same bytes.
 */
export function appIconIco(): Buffer {
  const images = APP_ICON_SIZES.map((size) => {
    const pixels = appLogoPixels(size)
    return { size, data: size === 256 ? encodePng(size, pixels) : dibEntry(size, pixels) }
  })
  const directory = Buffer.alloc(ICONDIR_BYTES + ICONDIRENTRY_BYTES * images.length)
  // Reserved 0, type 1 (icon), the number of images.
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach(({ size, data }, index) => {
    const entry = ICONDIR_BYTES + ICONDIRENTRY_BYTES * index
    // Width, height (0 is 256), no colour table, reserved, 1 plane, 32 bits per pixel.
    directory.writeUInt8(size % 256, entry)
    directory.writeUInt8(size % 256, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([directory, ...images.map(({ data }) => data)])
}
