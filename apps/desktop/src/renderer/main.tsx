import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { useDaemonState } from './useDaemonState.js'

const container = document.getElementById('root')
if (container === null) throw new Error('A #root elem hiányzik az index.html-ből')

/** @param retries Igaz, ha a határ a következő állapotüzenetkor magától újrapróbálja. */
function overlayFailed(message: string, retries: boolean): JSX.Element {
  return (
    <div className="empty">
      Az overlay hibába futott: {message}
      {retries ? '. A következő állapotfrissítéskor újrapróbálja.' : ''}
    </div>
  )
}

/**
 * A daemon-kapcsolat a hibahatár FÖLÖTT él: egy renderelési hiba így nem bontja a kapcsolatot, és a
 * következő állapotüzenet (`stateVersion`) újra megpróbálja az App renderelését.
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

// A külső határ a Root saját hibájára: ez nem áll vissza magától, de üres ablak helyett megmondja, mi történt.
createRoot(container).render(
  <ErrorBoundary label="root" fallback={(message) => overlayFailed(message, false)}>
    <Root />
  </ErrorBoundary>,
)
