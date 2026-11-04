import { describe, expect, it } from 'vitest'
import { hookPayload, parsedPayload } from './testing.js'

describe('hook payload fixtures', () => {
  it('hookPayload throws for an unknown name', () => {
    expect(() => hookPayload('permissionRequest_bsah')).toThrow('unknown fixture: permissionRequest_bsah')
    expect(hookPayload('permissionRequest_bash')['tool_name']).toBe('Bash')
  })

  it('parsedPayload throws did-not-parse only for an existing fixture', () => {
    expect(() => parsedPayload('permissionRequest_bsah')).toThrow('unknown fixture: permissionRequest_bsah')
    // A Stop body carries no tool, so it is not a permission request.
    expect(() => parsedPayload('stop')).toThrow('fixture stop did not parse')
    expect(parsedPayload('permissionRequest_bash').toolName).toBe('Bash')
  })
})
