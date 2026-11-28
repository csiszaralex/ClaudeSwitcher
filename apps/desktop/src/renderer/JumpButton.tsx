import type { JSX, KeyboardEvent } from 'react'
import type { SessionHost } from '../shared/request-source.js'
import { useReleaseKey } from './useReleaseKey.js'

/**
 * The handlers of a button that jumps to the session's window: a click jumps, and Enter on the
 * focused button jumps on its release (`useReleaseKey`), not on its press, as the list's Enter does.
 * The keydown's default is prevented, so the press does not click the button; the auto-repeat of a
 * held Enter does nothing. Space never reaches the button: App's Space opens the peek.
 */
export function useJumpButton(onJump: () => void): {
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
} {
  const release = useReleaseKey<undefined>(onJump)
  return {
    onClick: onJump,
    onKeyDown: (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      if (!event.repeat) release.arm(event.key, undefined)
    },
  }
}

/**
 * The way out of a request the app cannot decide: the window the session runs in (its VS Code
 * window or its terminal) has the native prompt. The text names that host (`sessionHost`).
 */
export function JumpButton({ host, onJump }: { host: SessionHost; onJump: () => void }): JSX.Element {
  const handlers = useJumpButton(onJump)
  return (
    <button type="button" {...handlers}>
      Ugrás {host.to}
    </button>
  )
}
