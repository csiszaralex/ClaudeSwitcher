import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './ErrorBoundary.js'
import { SetupWindow } from './SetupWindow.js'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('A #root elem hiányzik a setup.html-ből')

function setupFailed(message: string): JSX.Element {
  return <div className="empty">A beállítások ablak hibába futott: {message}</div>
}

createRoot(container).render(
  <ErrorBoundary label="setup" fallback={setupFailed}>
    <SetupWindow api={window.claudeswitcherSetup} />
  </ErrorBoundary>,
)
