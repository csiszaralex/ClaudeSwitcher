import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { useDaemonState } from './useDaemonState.js'

const container = document.getElementById('root')
if (container === null) throw new Error('The #root element is missing from index.html')

/** @param retries True if the boundary retries on its own at the next state message. */
function overlayFailed(message: string, retries: boolean): JSX.Element {
  return (
    <div className="empty">
      Az overlay hibába futott: {message}
      {retries ? '. A következő állapotfrissítéskor újrapróbálja.' : ''}
    </div>
  )
}

/**
 * The daemon connection lives ABOVE the error boundary: so a render error does not break the
 * connection, and the next state message (`stateVersion`) retries rendering App.
 */
function Root(): JSX.Element {
  const overlay = useDaemonState()
  return (
    <ErrorBoundary
      label="overlay"
      resetKey={overlay.stateVersion}
      fallback={(message) => overlayFailed(message, true)}
    >
      <App overlay={overlay} />
    </ErrorBoundary>
  )
}

// The outer boundary is for Root's own error: it does not recover on its own, but instead of an
// empty window it says what happened.
createRoot(container).render(
  <ErrorBoundary label="root" fallback={(message) => overlayFailed(message, false)}>
    <Root />
  </ErrorBoundary>,
)
