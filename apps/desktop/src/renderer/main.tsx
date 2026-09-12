import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'

function App(): JSX.Element {
  return <div>ClaudeSwitcher</div>
}

createRoot(document.getElementById('root')!).render(<App />)
