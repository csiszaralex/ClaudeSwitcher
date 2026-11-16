import { crc32, deflateSync } from 'node:zlib'
import type { TrayState } from './tray-state.js'

/**
 * The tray icon's colours, `#rrggbb`. The one home of the tray's colours; where the list shows the
 * same state, the value equals the list's CSS variable in `renderer/styles.css`, and
 * `tray-icon.test.ts` checks that the two agree.
 */
export const TRAY_COLORS = {
  /** Nothing waits. The pixels of `resources/tray.png`, the source of the app icon (`scripts/make-icon.mjs`). */
  idle: '#8a8880',
  /** A yes/no request or a Notification wait: `--accent`. */
  yesNo: '#d97757',
  /** A request that asks for a choice (a question or a plan): `--choice`. */
  choice: '#b8406a',
} as const

/** What the icon shows: a disc in one colour. */
export interface TrayLook {
  fill: string
}

/** The icon for a tray state. */
export function trayLook(state: TrayState): TrayLook {
  switch (state.wait) {
    case 'none':
      return { fill: TRAY_COLORS.idle }
    case 'yes-no':
      return { fill: TRAY_COLORS.yesNo }
    case 'choice':
      return { fill: TRAY_COLORS.choice }
  }
}

/** Only 16x16 for now: the size Windows shows in the taskbar at 100 % scaling. */
export const TRAY_ICON_SIZE = 16

/**
 * The disc: the pixels whose centre lies within this squared distance of the icon's centre. 41 (a
 * radius of about 6.4 px) gives the 12 px disc of `resources/tray.png` exactly.
 */
const DISC_RADIUS_SQ = 41

const BYTES_PER_PIXEL = 4

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** The squared distance of a pixel's centre from the icon's centre. */
function distanceSq(x: number, y: number): number {
  const middle = TRAY_ICON_SIZE / 2
  return (x + 0.5 - middle) ** 2 + (y + 0.5 - middle) ** 2
}

/** The colour of one pixel, `undefined` for a transparent one. */
function pixelColor(look: TrayLook, x: number, y: number): string | undefined {
  return distanceSq(x, y) <= DISC_RADIUS_SQ ? look.fill : undefined
}

/** The icon as `TRAY_ICON_SIZE` x `TRAY_ICON_SIZE` RGBA pixels, row by row; transparent pixels are all zero. */
export function trayIconPixels(look: TrayLook): Buffer {
  const pixels = Buffer.alloc(TRAY_ICON_SIZE * TRAY_ICON_SIZE * BYTES_PER_PIXEL)
  for (let y = 0; y < TRAY_ICON_SIZE; y++) {
    for (let x = 0; x < TRAY_ICON_SIZE; x++) {
      const color = pixelColor(look, x, y)
      if (color === undefined) continue
      const [red, green, blue] = rgb(color)
      pixels.set([red, green, blue, 0xff], (y * TRAY_ICON_SIZE + x) * BYTES_PER_PIXEL)
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
 * The icon as a PNG file in memory, for `nativeImage.createFromBuffer`. A PNG, not raw pixels for
 * `createFromBitmap`: Electron documents the bitmap's byte order as platform-dependent, a PNG's is
 * fixed. 8-bit RGBA, no interlacing, filter 0 on every line.
 */
export function trayIconPng(look: TrayLook): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(TRAY_ICON_SIZE, 0)
  header.writeUInt32BE(TRAY_ICON_SIZE, 4)
  // Bit depth 8, colour type 6 (RGBA), compression 0, filter 0, no interlacing.
  header.set([8, 6, 0, 0, 0], 8)
  const pixels = trayIconPixels(look)
  const stride = TRAY_ICON_SIZE * BYTES_PER_PIXEL
  const raw = Buffer.alloc((stride + 1) * TRAY_ICON_SIZE)
  for (let y = 0; y < TRAY_ICON_SIZE; y++) {
    // The filter byte of each line stays 0 (none).
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
