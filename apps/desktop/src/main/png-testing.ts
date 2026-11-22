import { inflateSync } from 'node:zlib'

// Tests only: a PNG decoder written apart from `icon-raster.ts` `encodePng`, so a test reads what
// the encoder wrote the way any reader would, instead of trusting the encoder's own view.

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export interface DecodedPng {
  width: number
  height: number
  /** RGBA, row by row. */
  pixels: Buffer
}

/**
 * Decodes the only PNG shape the app writes: 8-bit RGBA, no interlacing, filter 0 on every line.
 * Throws on anything else, and on a chunk whose CRC does not match.
 */
export function decodePng(bytes: Buffer): DecodedPng {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG signature')
  const idat: Buffer[] = []
  let width = 0
  let height = 0
  let ended = false
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const crc = bytes.readUInt32BE(offset + 8 + length)
    if (crc !== crc32Of(bytes.subarray(offset + 4, offset + 8 + length))) throw new Error(`bad CRC in ${type}`)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const format = [...data.subarray(8, 13)].join(',')
      if (format !== '8,6,0,0,0') throw new Error(`unexpected PNG format ${format}`)
    }
    if (type === 'IDAT') idat.push(data)
    if (type === 'IEND') ended = true
    offset += 12 + length
  }
  if (!ended) throw new Error('no IEND')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  if (raw.length !== (stride + 1) * height) throw new Error(`unexpected data length ${raw.length}`)
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error(`filter other than 0 on line ${y}`)
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels }
}

/** CRC-32 (the PNG polynomial), bit by bit: independent of `node:zlib` `crc32`, which the encoder uses. */
function crc32Of(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
