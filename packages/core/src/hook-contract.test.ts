import { describe, expect, it } from 'vitest'
import {
  HOOK_CONTRACT,
  LEGACY_HOOK_CONTRACT,
  OUR_HOOK_PATHS,
  PERMISSION_RELEASE_AFTER_MS,
  PERMISSION_RELEASE_MARGIN_MS,
  PERMISSION_REQUEST_TIMEOUT_S,
  hookPath,
  isLifecycleKind,
  lifecyclePath,
} from './hook-contract.js'

describe('hook contract', () => {
  it('releases a held PermissionRequest before Claude Code times the hook out', () => {
    expect(PERMISSION_RELEASE_MARGIN_MS).toBeGreaterThan(0)
    expect(PERMISSION_RELEASE_AFTER_MS).toBeGreaterThan(0)
    expect(PERMISSION_RELEASE_AFTER_MS).toBeLessThan(PERMISSION_REQUEST_TIMEOUT_S * 1000)
    expect(PERMISSION_RELEASE_AFTER_MS).toBe(PERMISSION_REQUEST_TIMEOUT_S * 1000 - PERMISSION_RELEASE_MARGIN_MS)
  })

  it('installs PermissionRequest with the timeout the release is derived from', () => {
    const entry = HOOK_CONTRACT.find((hook) => hook.event === 'PermissionRequest')
    expect(entry?.timeoutSeconds).toBe(PERMISSION_REQUEST_TIMEOUT_S)
  })

  it('lists every event once, and no retired event among the installed ones', () => {
    const events = HOOK_CONTRACT.map((hook) => hook.event)
    expect(new Set(events).size).toBe(events.length)
    for (const legacy of LEGACY_HOOK_CONTRACT) expect(events).not.toContain(legacy.event)
  })

  it('recognises the installed and the retired paths as ours, and nothing else', () => {
    for (const hook of [...HOOK_CONTRACT, ...LEGACY_HOOK_CONTRACT]) {
      expect(OUR_HOOK_PATHS.has(hookPath(hook.route))).toBe(true)
    }
    expect(OUR_HOOK_PATHS.has('/hooks/lifecycle/start')).toBe(true)
    expect(OUR_HOOK_PATHS.has('/hooks/other')).toBe(false)
    expect(OUR_HOOK_PATHS.has('/statusline')).toBe(false)
  })

  it('takes the lifecycle kinds from the installed lifecycle routes only', () => {
    expect(isLifecycleKind('end')).toBe(true)
    expect(isLifecycleKind('stop')).toBe(true)
    expect(isLifecycleKind('start')).toBe(false)
    expect(isLifecycleKind('bogus')).toBe(false)
    expect(lifecyclePath('stop')).toBe(hookPath('lifecycle/stop'))
  })
})
