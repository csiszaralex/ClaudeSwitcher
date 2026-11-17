import { describe, expect, it } from 'vitest'
import { readAppVersion, withAppVersion } from './useAppVersion.js'

describe('readAppVersion', () => {
  it('reads a version string', () => {
    expect(readAppVersion('0.2.0')).toBe('0.2.0')
    expect(readAppVersion('0.0.0')).toBe('0.0.0')
  })

  it('gives undefined for anything else', () => {
    for (const raw of [undefined, null, '', 2, { version: '0.2.0' }, ['0.2.0']]) {
      expect(readAppVersion(raw)).toBeUndefined()
    }
  })
})

describe('withAppVersion', () => {
  it('puts the version before the check time', () => {
    expect(withAppVersion('0.2.0', 'ellenőrizve: 2mp')).toBe('0.2.0 · ellenőrizve: 2mp')
  })

  it('leaves the check time alone without a version', () => {
    expect(withAppVersion(undefined, 'ellenőrizve: még nem')).toBe('ellenőrizve: még nem')
  })
})
