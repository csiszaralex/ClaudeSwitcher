import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { userDataDir } from './user-data.js'

describe('userDataDir', () => {
  it("keeps the directory today's builds use", () => {
    expect(userDataDir('C:\\Users\\u\\AppData\\Roaming')).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', '@claudeswitcher', 'desktop'),
    )
  })
})
