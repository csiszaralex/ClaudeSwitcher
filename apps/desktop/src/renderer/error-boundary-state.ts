import { errorMessage } from '../shared/error-message.js'

/**
 * The `ErrorBoundary` state and the reset decision, without React, so it can be tested.
 *
 * - `message`: the error message while the boundary is down; `undefined` when healthy.
 * - `failedAt`: the value of the reset key (`resetKey`) at the moment of the error.
 */
export interface BoundaryState {
  message: string | undefined
  failedAt: number | undefined
}

/** The state after an error. The next `nextBoundaryState` records the key. */
export function failedState(error: unknown): BoundaryState {
  return { message: errorMessage(error), failedAt: undefined }
}

/**
 * The boundary's state with the current reset key (React `getDerivedStateFromProps`).
 *
 * The boundary recovers when the key has changed since the error, that is, a new state message
 * came. If the error repeated at the same key, the boundary stays down until the next message: so
 * a state that always fails does not spin the render in an endless loop.
 *
 * Without a key (`undefined`) the boundary never recovers on its own. The decision panel's boundary
 * is such a one; React's `key` (the request id) rebuilds it.
 */
export function nextBoundaryState(state: BoundaryState, resetKey: number | undefined): BoundaryState {
  if (state.message === undefined || resetKey === undefined) return state
  if (state.failedAt === undefined) return { ...state, failedAt: resetKey }
  if (state.failedAt !== resetKey) return { message: undefined, failedAt: undefined }
  return state
}
