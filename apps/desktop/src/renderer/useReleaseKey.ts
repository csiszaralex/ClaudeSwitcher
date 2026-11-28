import { useEffect, useRef } from 'react'

/** A key armed to act on its release (`useReleaseKey`). */
export interface ReleaseKey<T> {
  /** Arms the key: its next release in the overlay acts with `value`. A later arm replaces it. */
  arm(key: string, value: T): void
  /** Disarms it without acting. */
  disarm(): void
}

/**
 * A key that acts on its release, not on its press: for every key that takes the focus away from
 * the overlay (Esc hides it, Enter and Tab jump to a session). The window that gets the focus then
 * would otherwise get the key's release, and its auto-repeat if held: a browser showing a video full
 * screen took the Esc as its own and left full screen (seen by the owner, 2026-11-22), and a held
 * Enter's repeats could send a half-typed prompt in VS Code.
 *
 * The caller arms it on the keydown it handles, and only on a press, not on an auto-repeat
 * (`event.repeat`), so a held key acts once, on its one release. Only a release of the armed key
 * acts: a release whose press went down elsewhere (before the overlay showed) does nothing, and the
 * focus leaving the overlay meanwhile (`blur`) disarms it. `act` gets the value given at the press,
 * so the action is the one the press chose, whatever changed until the release.
 */
export function useReleaseKey<T>(act: (value: T) => void): ReleaseKey<T> {
  const armed = useRef<{ key: string; value: T } | undefined>(undefined)
  // The latest `act`, so the listeners below can stay for the component's life.
  const latestAct = useRef(act)
  useEffect(() => {
    latestAct.current = act
  })
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent): void => {
      const current = armed.current
      if (current === undefined || event.key !== current.key) return
      armed.current = undefined
      event.preventDefault()
      latestAct.current(current.value)
    }
    const disarm = (): void => {
      armed.current = undefined
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', disarm)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', disarm)
    }
  }, [])
  const handle = useRef<ReleaseKey<T>>({
    arm: (key, value) => {
      armed.current = { key, value }
    },
    disarm: () => {
      armed.current = undefined
    },
  })
  return handle.current
}
