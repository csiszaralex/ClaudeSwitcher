import { describe, expect, it } from 'vitest'
import { sandboxDisabled } from './sandbox.js'

describe('sandboxDisabled', () => {
  it('is true only for an explicit dangerouslyDisableSandbox: true', () => {
    expect(sandboxDisabled({ command: 'ls', dangerouslyDisableSandbox: true })).toBe(true)
    expect(sandboxDisabled({ command: 'ls', dangerouslyDisableSandbox: false })).toBe(false)
    expect(sandboxDisabled({ command: 'ls', dangerouslyDisableSandbox: 'true' })).toBe(false)
    expect(sandboxDisabled({ command: 'ls' })).toBe(false)
    expect(sandboxDisabled(null)).toBe(false)
  })
})
