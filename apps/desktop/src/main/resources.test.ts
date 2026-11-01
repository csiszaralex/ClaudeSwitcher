import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resourcesDir } from './resources.js'

describe('resourcesDir', () => {
  it('packaged icons live next to app.asar', () => {
    expect(resourcesDir(true, 'C:\\app\\resources', 'C:\\app\\resources\\app.asar\\out\\main')).toBe(
      path.join('C:\\app\\resources', 'icons'),
    )
  })

  it('repo builds read the source folder', () => {
    expect(resourcesDir(false, 'ignored', 'p:\\proj\\alpha\\apps\\desktop\\out\\main')).toBe(
      path.join('p:\\proj\\alpha\\apps\\desktop', 'resources'),
    )
  })
})
