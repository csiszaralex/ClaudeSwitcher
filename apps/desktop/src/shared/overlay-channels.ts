import type { Daemon } from '@claudeswitcher/daemon'

/**
 * The overlay's IPC channels: the main process handles the requests and sends `shown`, the overlay
 * preload (`preload/index.ts`) invokes and listens. Only a type import here: the preload bundles
 * this module, and the setup preload must never import it (a chunk shared by the two preloads
 * would not load in a sandboxed preload).
 */
export const OVERLAY_CHANNELS = {
  connection: 'daemon:connection',
  state: 'daemon:state',
  decide: 'decision:decide',
  focusSession: 'session:focus',
  hide: 'overlay:hide',
  settings: 'settings:get',
  /** Pushed by the main process when the overlay window is shown. */
  shown: 'overlay:shown',
} as const

/** The reply to `decide`: the daemon's `DecideResult`, which the renderer reads with a check. */
export type DecideOutcome = ReturnType<Daemon['decide']>
