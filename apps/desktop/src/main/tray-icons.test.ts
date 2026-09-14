import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../resources')
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe.each(['tray.png', 'tray-waiting.png'])('%s', (file) => {
  it('is a 16x16 RGBA PNG', () => {
    // A PNG szerkezetét ellenőrzi: szignatúra, IHDR méret és színtípus. A teljes
    // dekódolást (CRC, IDAT) NEM — azt a futó app createTray-je méri, ami üres képnél
    // dob, tehát a korlátos indítás tálca-sora azt fedi le.
    const bytes = readFileSync(path.join(resources, file))
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(bytes.readUInt32BE(16)).toBe(16)
    expect(bytes.readUInt32BE(20)).toBe(16)
    expect(bytes[25]).toBe(6)
  })
})
