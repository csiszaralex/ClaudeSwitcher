// Generates the installer and exe icon (`resources/icon.png`, 256x256) from the 16x16 tray icon,
// scaled up nearest-neighbour so the pixel art stays sharp. electron-builder needs at least 256x256.
// Run once from `apps/desktop`: `node scripts/make-icon.mjs`. The output is committed.
//
// Handles only what `resources/tray.png` is: 8-bit RGBA, non-interlaced. Anything else throws.
import { readFileSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const SOURCE = new URL('../resources/tray.png', import.meta.url)
const TARGET = new URL('../resources/icon.png', import.meta.url)
const SIZE = 256
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const BYTES_PER_PIXEL = 4

function readChunks(bytes) {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  const chunks = []
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  return chunks
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function decode(bytes) {
  const chunks = readChunks(bytes)
  const header = chunks.find((chunk) => chunk.type === 'IHDR')
  if (header === undefined) throw new Error('no IHDR')
  const width = header.data.readUInt32BE(0)
  const height = header.data.readUInt32BE(4)
  const [bitDepth, colorType, , , interlace] = header.data.subarray(8, 13)
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG: bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}`)
  }
  const raw = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)))
  const stride = width * BYTES_PER_PIXEL
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= BYTES_PER_PIXEL ? pixels[y * stride + x - BYTES_PER_PIXEL] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= BYTES_PER_PIXEL && y > 0 ? pixels[(y - 1) * stride + x - BYTES_PER_PIXEL] : 0
      let predictor
      switch (filter) {
        case 0:
          predictor = 0
          break
        case 1:
          predictor = left
          break
        case 2:
          predictor = up
          break
        case 3:
          predictor = Math.floor((left + up) / 2)
          break
        case 4:
          predictor = paeth(left, up, upLeft)
          break
        default:
          throw new Error(`unknown filter ${filter} on line ${y}`)
      }
      pixels[y * stride + x] = (line[x] + predictor) & 0xff
    }
  }
  return { width, height, pixels }
}

function scale({ width, height, pixels }, size) {
  const out = Buffer.alloc(size * size * BYTES_PER_PIXEL)
  for (let y = 0; y < size; y++) {
    const sourceY = Math.floor((y * height) / size)
    for (let x = 0; x < size; x++) {
      const sourceX = Math.floor((x * width) / size)
      const from = (sourceY * width + sourceX) * BYTES_PER_PIXEL
      pixels.copy(out, (y * size + x) * BYTES_PER_PIXEL, from, from + BYTES_PER_PIXEL)
    }
  }
  return out
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

function encode(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = size * BYTES_PER_PIXEL
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    // Filter byte 0 (none) on every line.
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const image = decode(readFileSync(SOURCE))
writeFileSync(TARGET, encode(SIZE, scale(image, SIZE)))
console.log(`wrote resources/icon.png (${SIZE}x${SIZE}) from ${image.width}x${image.height}`)
