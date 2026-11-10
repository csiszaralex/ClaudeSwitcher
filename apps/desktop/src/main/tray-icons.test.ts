import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../resources')
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe.each(['tray.png', 'tray-waiting.png'])('%s', (file) => {
  it('is a 16x16 RGBA PNG', () => {
    // Checks the PNG structure: signature, IHDR size and colour type. NOT the full decoding (CRC,
    // IDAT): the running app's createTray measures that, since it throws on an empty image, so the
    // tray line of a bounded startup run covers it.
    const bytes = readFileSync(path.join(resources, file))
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(bytes.readUInt32BE(16)).toBe(16)
    expect(bytes.readUInt32BE(20)).toBe(16)
    expect(bytes[25]).toBe(6)
  })
})
