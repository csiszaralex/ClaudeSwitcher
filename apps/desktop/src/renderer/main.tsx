import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'

const container = document.getElementById('root')
if (container === null) throw new Error('A #root elem hiányzik az index.html-ből')

createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
