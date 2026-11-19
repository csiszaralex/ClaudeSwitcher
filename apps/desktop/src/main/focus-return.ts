/**
 * Gives the focus back to the window that was in front before the overlay opened (issue #7).
 * Generic over the window, so the order can be tested without user32; `main/index.ts` passes
 * `focus-window.ts` `captureForeground` and `giveBackForeground`.
 */
export interface FocusReturnSteps<W> {
  /** The window in the foreground now, or `undefined` when there is none worth giving back. Only reads. */
  capture(): W | undefined
  /** Brings the window back to the front; it may refuse (the window is gone, the foreground lock). */
  restore(window: W): Promise<unknown>
}

export interface FocusReturn {
  /**
   * Remembers the foreground window. `main/overlay-window.ts` calls it when the overlay opens, BEFORE
   * it shows and focuses the overlay: after that the overlay would be the foreground window.
   */
  readonly remember: () => void
  /**
   * Hides the overlay through `hide`, and when `focused` (the overlay has the focus), gives the focus
   * back to the remembered window first. The remembered window is used once.
   *
   * The order is the jump's (`main/index.ts` `focusSession`): Windows allows `SetForegroundWindow`
   * only to the process in the foreground, which the app is while the overlay has the focus; hiding
   * it first could take that right away, and the call would only flash the taskbar button. Without
   * the focus (the foreground lock refused it, so another window is in front) nothing is given back:
   * the user is already elsewhere. A failing restore is logged, never thrown.
   */
  readonly dismiss: (focused: boolean, hide: () => void) => Promise<void>
}

export function createFocusReturn<W>(steps: FocusReturnSteps<W>): FocusReturn {
  let previous: W | undefined
  return {
    remember: () => {
      previous = steps.capture()
    },
    dismiss: async (focused, hide) => {
      const window = previous
      previous = undefined
      try {
        if (focused && window !== undefined) await steps.restore(window)
      } catch (error) {
        // The overlay must hide all the same, and the renderer's Esc must not get a rejection.
        console.error('[focus] could not give the focus back', error)
      }
      hide()
    },
  }
}
