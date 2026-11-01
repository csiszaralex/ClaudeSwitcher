import { Component, type ErrorInfo, type ReactNode } from 'react'
import { failedState, nextBoundaryState, type BoundaryState } from './error-boundary-state.js'

interface Props {
  children: ReactNode
  /** A naplósorban: melyik határ kapta el a hibát. */
  label: string
  /** Amit a hiba helyén mutatunk; a hibaüzenetet kapja. */
  fallback: (message: string) => ReactNode
  /**
   * Visszaállító kulcs: ha a hiba óta megváltozik, a határ újra a gyerekeit rendereli (lásd
   * `nextBoundaryState`). Nélküle a határ csak a React `key`-ével építhető újra.
   */
  resetKey?: number | undefined
}

/**
 * Egy renderelési hiba különben az egész overlayt leszedné, és üres ablakot hagyna. Egy
 * monitorozó eszközben ez a legrosszabb kimenet: pont akkor nem mutat semmit, amikor
 * ránézel, és úgy néz ki, mintha nem lenne futó session.
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
