import { Component, type ErrorInfo, type ReactNode } from 'react'
import { failedState, nextBoundaryState, type BoundaryState } from './error-boundary-state.js'

interface Props {
  children: ReactNode
  /** In the log line: which boundary caught the error. */
  label: string
  /** What is shown in place of the error; it gets the error message. */
  fallback: (message: string) => ReactNode
  /**
   * The reset key: if it changes after the error, the boundary renders its children again (see
   * `nextBoundaryState`). Without it the boundary can be rebuilt only through React's `key`.
   */
  resetKey?: number | undefined
}

/**
 * Otherwise a render error would take down the whole overlay and leave an empty window. In a
 * monitoring tool that is the worst outcome: it shows nothing exactly when you look at it, and it
 * looks as if no session were running.
 */
export class ErrorBoundary extends Component<Props, BoundaryState> {
  override state: BoundaryState = { message: undefined, failedAt: undefined }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return failedState(error)
  }

  static getDerivedStateFromProps(props: Props, state: BoundaryState): BoundaryState {
    return nextBoundaryState(state, props.resetKey)
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[renderer] render failed (${this.props.label})`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message !== undefined) return this.props.fallback(this.state.message)
    return this.props.children
  }
}
