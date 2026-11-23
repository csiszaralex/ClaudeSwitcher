import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { useAutoAccept } from './useAutoAccept.js'
import { useDaemonState } from './useDaemonState.js'
import { useExcludedSessions } from './useExcludedSessions.js'
import { useSeenFinishes } from './useSeenFinishes.js'

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
 * The daemon connection (and the seen finishes, the excluded sessions and the auto-accept sessions)
 * live ABOVE the error boundary: so a render error does not break the connection, and the next state message
 * (`stateVersion`) retries rendering App.
 */
function Root(): JSX.Element {
  const overlay = useDaemonState()
  const [seenFinishes, trackSeen] = useSeenFinishes()
  const [exclusion, trackExcluded] = useExcludedSessions()
  const [autoAccept, trackAutoAccept] = useAutoAccept()
  return (
    <ErrorBoundary
      label="overlay"
      resetKey={overlay.stateVersion}
      fallback={(message) => overlayFailed(message, true)}
    >
      <App
        overlay={overlay}
        seenFinishes={seenFinishes}
        trackSeen={trackSeen}
        exclusion={exclusion}
        trackExcluded={trackExcluded}
        autoAccept={autoAccept}
        trackAutoAccept={trackAutoAccept}
      />
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
