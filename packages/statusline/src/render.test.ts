import { describe, expect, it } from 'vitest'
import { renderStatusLine } from './render.js'

const base = {
  model: { display_name: 'Opus 5' },
  workspace: { current_dir: 'p:\\proj\\alpha' },
}

describe('renderStatusLine', () => {
  it('shows model and directory', () => {
    const line = renderStatusLine(base)
    expect(line).toContain('Opus 5')
    expect(line).toContain('alpha')
  })

  it('shows the five hour and seven day usage when present', () => {
    const line = renderStatusLine({
      ...base,
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1 },
        seven_day: { used_percentage: 41.2, resets_at: 1 },
      },
    })
    expect(line).toContain('5h 24%')
    expect(line).toContain('7d 41%')
  })

  it('omits a window that is absent', () => {
    const line = renderStatusLine({
      ...base,
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } },
    })
    expect(line).toContain('5h 10%')
    expect(line).not.toContain('7d')
  })

  it('renders without rate limits at all', () => {
    expect(() => renderStatusLine(base)).not.toThrow()
    expect(renderStatusLine(base)).not.toContain('5h')
  })

  it('survives a completely empty input', () => {
    expect(() => renderStatusLine({})).not.toThrow()
  })

  it('shows the git branch when present', () => {
    const line = renderStatusLine({ ...base, workspace: { current_dir: 'p:\\a', branch: 'main' } })
    expect(line).toContain('main')
  })
})
