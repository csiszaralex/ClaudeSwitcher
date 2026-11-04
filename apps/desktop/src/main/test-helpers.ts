/** The fake `globalShortcut` pair, plus the hooks a test drives it with. */
export interface FakeShortcuts {
  deps: { register: (accelerator: string, handler: () => void) => boolean; unregister: (accelerator: string) => void }
  /** What is registered right now. */
  registered: Set<string>
  /** Every `register` and `unregister` call in order, as `register <accelerator>`. */
  calls: string[]
  /** Fires a registered shortcut, as Windows would. */
  press: (accelerator: string) => void
  /** Another application grabs a free accelerator: registering it fails from now on. */
  take: (accelerator: string) => void
}

/**
 * A fake `globalShortcut` that tracks what is registered and logs every call. `registered` is
 * what is held before the test starts, `taken` what another application holds, `invalid` what
 * Electron cannot parse (it throws), and `failUnregister` makes every unregister throw. Only tests
 * import this file, so no bundle reaches it.
 */
export function fakeShortcuts(
  options: { registered?: string[]; taken?: string[]; invalid?: string[]; failUnregister?: boolean } = {},
): FakeShortcuts {
  const registered = new Set<string>(options.registered)
  const taken = new Set<string>(options.taken)
  const handlers = new Map<string, () => void>()
  const calls: string[] = []
  return {
    deps: {
      register: (accelerator, handler) => {
        calls.push(`register ${accelerator}`)
        if (options.invalid?.includes(accelerator) === true) throw new Error(`cannot parse ${accelerator}`)
        if (taken.has(accelerator)) return false
        registered.add(accelerator)
        handlers.set(accelerator, handler)
        return true
      },
      unregister: (accelerator) => {
        calls.push(`unregister ${accelerator}`)
        if (options.failUnregister === true) throw new Error('unregister failed')
        registered.delete(accelerator)
      },
    },
    registered,
    calls,
    press: (accelerator) => {
      if (registered.has(accelerator)) handlers.get(accelerator)?.()
    },
    take: (accelerator) => {
      taken.add(accelerator)
    },
  }
}
