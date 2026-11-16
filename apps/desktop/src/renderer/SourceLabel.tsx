import type { JSX } from 'react'
import type { RequestSource } from '../shared/request-source.js'

/**
 * The source label (shared/request-source.ts `requestSource`), emphasised when it stands out. The
 * decision panel and the status bar both show it, so the two look the same.
 */
export function SourceLabel({ source }: { source: RequestSource }): JSX.Element {
  return (
    <span className={source.standsOut ? 'source-label stands-out' : 'source-label'} title={source.title}>
      {source.label}
    </span>
  )
}
