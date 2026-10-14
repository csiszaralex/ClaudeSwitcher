import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  message: string | undefined
}

/**
 * Egy renderelési hiba különben az egész overlayt leszedné, és üres ablakot hagyna. Egy
 * monitorozó eszközben ez a legrosszabb kimenet: pont akkor nem mutat semmit, amikor
 * ránézel — és úgy néz ki, mintha nem lenne futó session.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { message: undefined }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[overlay] render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message !== undefined) {
      return <div className="empty">Az overlay hibába futott: {this.state.message}</div>
    }
    return this.props.children
  }
}
