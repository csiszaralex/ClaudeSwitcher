import type { JSX } from 'react'
import type { SessionHost } from '../shared/request-source.js'

/**
 * The way out of a request the app cannot decide: the window the session runs in (its VS Code
 * window or its terminal) has the native prompt. The text names that host (`sessionHost`).
 */
export function JumpButton({ host, onJump }: { host: SessionHost; onJump: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onJump}>
      Ugrás {host.to}
    </button>
  )
}
