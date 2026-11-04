import type { JSX } from 'react'

/** The way out of a request the app cannot decide: the session's VSCode window has the native prompt. */
export function JumpButton({ onJump }: { onJump: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onJump}>
      Ugrás a VSCode-ba
    </button>
  )
}
