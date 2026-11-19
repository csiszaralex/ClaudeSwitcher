import { describe, expect, it } from 'vitest'
import { formatDuration, promptedByNote, shortenPath, subagentLabel, subagentTooltip, summarize, toolLabel, waitsOnText } from './format.js'

/** The overlay's clock for `summarize`; only the usage limit's text depends on it. */
const NOW = Date.parse('2026-09-04T10:00:00.000Z')

describe('shortenPath', () => {
  it('keeps the first two and the last two segments of a long Windows path', () => {
    expect(shortenPath('P:\\proj\\alpha\\apps\\beta')).toBe('P:\\proj\\…\\apps\\beta')
    expect(shortenPath('P:\\proj\\alpha\\gamma\\apps\\beta')).toBe('P:\\proj\\…\\apps\\beta')
  })

  it('keeps a path of up to four segments as it is', () => {
    for (const path of ['P:\\proj\\alpha\\beta', 'P:\\proj', 'beta', '', '/home/u/proj']) expect(shortenPath(path)).toBe(path)
  })

  it('shortens a POSIX path with its own separator and keeps the root', () => {
    expect(shortenPath('/home/u/proj/apps/beta')).toBe('/home/u/…/apps/beta')
  })

  it('keeps a UNC prefix', () => {
    expect(shortenPath('\\\\server\\share\\proj\\apps\\beta')).toBe('\\\\server\\share\\…\\apps\\beta')
  })

  it('splits on both separators and joins with the first one in the path', () => {
    expect(shortenPath('P:\\proj/alpha\\apps/beta')).toBe('P:\\proj\\…\\apps\\beta')
  })

  it('ignores a trailing separator when counting', () => {
    expect(shortenPath('P:\\proj\\alpha\\beta\\')).toBe('P:\\proj\\alpha\\beta\\')
    expect(shortenPath('P:\\proj\\alpha\\apps\\beta\\')).toBe('P:\\proj\\…\\apps\\beta')
  })
})

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45 mp')
  })

  it('renders minutes and seconds', () => {
    expect(formatDuration(134_000)).toBe('2:14')
  })

  it('renders hours', () => {
    expect(formatDuration(3_700_000)).toBe('1:01:40')
  })

  it('clamps a negative duration to zero', () => {
    expect(formatDuration(-5)).toBe('0 mp')
  })
})

describe('summarize', () => {
  it('prefers the notification text when waiting', () => {
    const line = summarize({
      status: 'waiting',
      notificationText: 'Claude needs permission to run pnpm test',
      activity: { runningTool: 'Bash' },
    }, NOW)
    expect(line).toBe('Claude needs permission to run pnpm test')
  })

  it('names the running tool when working', () => {
    expect(summarize({ status: 'working', activity: { runningTool: 'Bash' } }, NOW)).toBe('Bash fut')
  })

  it('shows the last assistant text when idle', () => {
    expect(summarize({ status: 'idle', activity: { lastAssistantText: 'Kész.' } }, NOW)).toBe('Kész.')
  })

  it('truncates a long summary', () => {
    const long = 'x'.repeat(200)
    expect(summarize({ status: 'idle', activity: { lastAssistantText: long } }, NOW).length).toBe(80)
  })

  it('falls back when there is nothing to say', () => {
    expect(summarize({ status: 'idle', activity: {} }, NOW)).toBe('—')
  })

  it('survives a session whose activity is missing entirely', () => {
    // By its type the daemon always gives `activity`, but a bad message does not. This would throw
    // during render, and the whole overlay would disappear.
    const broken = { status: 'idle' } as unknown as Parameters<typeof summarize>[0]
    expect(() => summarize(broken, NOW)).not.toThrow()
    expect(summarize(broken, NOW)).toBe('—')
  })

  it('shows the usage limit of an idle session instead of the last assistant text', () => {
    // No `resetsAt` and an expired one: neither text depends on the machine's time zone.
    const activity = { lastAssistantText: 'Kész.', usageLimit: { kind: 'five_hour' } }
    expect(summarize({ status: 'idle', activity }, NOW)).toBe('Elérte az 5 órás limitet.')
    const expired = { lastAssistantText: 'Kész.', usageLimit: { kind: 'five_hour', resetsAt: NOW - 1 } }
    expect(summarize({ status: 'idle', activity: expired }, NOW)).toBe('A limit lejárt, folytathatod.')
  })

  it('does not show the usage limit of a session that works or waits again', () => {
    const activity = { runningTool: 'Bash', usageLimit: { kind: 'five_hour' } }
    expect(summarize({ status: 'working', activity }, NOW)).toBe('Bash fut')
    expect(summarize({ status: 'waiting', notificationText: 'Engedély kell', activity }, NOW)).toBe('Engedély kell')
  })
})

describe('toolLabel', () => {
  it('names a tool with nothing more to say as running', () => {
    expect(toolLabel('Bash')).toBe('Bash fut')
  })

  it('shows the command of a shell tool after a colon', () => {
    expect(toolLabel('Bash', 'pnpm test')).toBe('Bash: pnpm test')
    expect(toolLabel('PowerShell', 'Get-Date')).toBe('PowerShell: Get-Date')
  })

  it('quotes the subject of any other tool', () => {
    expect(toolLabel('Grep', 'createPanel')).toBe('Grep „createPanel”')
  })
})

describe('summarize: the tool detail and the subagents', () => {
  const searching = { agentId: 'a1', description: 'Final-review fix wave', runningTool: 'Grep', toolDetail: 'createPanel', updatedAt: 2 }
  const reading = { agentId: 'a2', agentType: 'Explore', runningTool: 'Read', toolDetail: 'x.ts', updatedAt: 1 }

  it('names what the main session tool works on', () => {
    expect(summarize({ status: 'working', activity: { runningTool: 'Bash', toolDetail: 'pnpm test' } }, NOW)).toBe('Bash: pnpm test')
  })

  it('shows the work of an active subagent instead of the main session', () => {
    const line = summarize({ status: 'working', activity: { runningTool: 'Agent' }, subagents: [searching] }, NOW)
    expect(line).toBe('↳ Final-review fix wave · Grep „createPanel”')
  })

  it('shows the most recent subagent and a count of the others', () => {
    const line = summarize({ status: 'idle', activity: {}, subagents: [searching, reading] }, NOW)
    expect(line).toBe('↳ +1 · Final-review fix wave · Grep „createPanel”')
  })

  it('falls back to the agent type, then to a generic name, and shows a subagent between tools', () => {
    expect(summarize({ status: 'idle', activity: {}, subagents: [reading] }, NOW)).toBe('↳ Explore · Read „x.ts”')
    expect(summarize({ status: 'idle', activity: {}, subagents: [{ agentId: 'a3', updatedAt: 1 }] }, NOW)).toBe('↳ subagent')
  })

  it('keeps the notification text of a waiting session over the subagents', () => {
    const line = summarize({ status: 'waiting', notificationText: 'Engedély kell', activity: {}, subagents: [searching] }, NOW)
    expect(line).toBe('Engedély kell')
  })

  it('ignores an empty subagent list', () => {
    expect(summarize({ status: 'idle', activity: { lastAssistantText: 'Kész.' }, subagents: [] }, NOW)).toBe('Kész.')
  })
})

describe('subagentTooltip', () => {
  it('lists every active subagent, one per line', () => {
    const tooltip = subagentTooltip([
      { agentId: 'a1', description: 'Első', runningTool: 'Bash', toolDetail: 'ls', updatedAt: 2 },
      { agentId: 'a2', agentType: 'Explore', updatedAt: 1 },
    ])
    expect(tooltip).toBe('↳ Első · Bash: ls\n↳ Explore')
  })

  it('has no tooltip without subagents', () => {
    expect(subagentTooltip(undefined)).toBeUndefined()
    expect(subagentTooltip([])).toBeUndefined()
  })
})

describe('subagentLabel', () => {
  const subagents = [
    { agentId: 'a1', agentType: 'general-purpose', description: 'Fix the review findings', updatedAt: 2 },
    { agentId: 'a2', agentType: 'Explore', description: 'Find the hook routes', updatedAt: 1 },
  ]

  it('has no label for a request of the main session', () => {
    expect(subagentLabel({}, subagents)).toBeUndefined()
  })

  it('shows the task description of the default agent type instead of the type', () => {
    expect(subagentLabel({ agentId: 'a1', agentType: 'general-purpose' }, subagents)).toBe(
      'subagent: Fix the review findings',
    )
  })

  it('keeps a type other than the default next to the description', () => {
    expect(subagentLabel({ agentId: 'a2', agentType: 'Explore' }, subagents)).toBe('subagent · Explore: Find the hook routes')
  })

  it('falls back to the type when no description is known', () => {
    expect(subagentLabel({ agentId: 'gone', agentType: 'general-purpose' }, subagents)).toBe('subagent · general-purpose')
    expect(subagentLabel({ agentId: 'a1', agentType: 'Explore' }, undefined)).toBe('subagent · Explore')
    expect(subagentLabel({ agentId: 'gone' }, [])).toBe('subagent')
  })

  it('clips a long description to one line', () => {
    const label = subagentLabel({ agentId: 'a1' }, [{ agentId: 'a1', description: 'x'.repeat(200), updatedAt: 1 }])
    expect(label).toHaveLength(80)
  })
})

describe('waitsOnText and promptedByNote', () => {
  it('names the sessions a row waits on', () => {
    expect(waitsOnText(['BohemApp', 'CRM master'])).toBe('Vár: BohemApp, CRM master')
  })

  it('clips a long list to the row text length', () => {
    expect(waitsOnText(Array.from({ length: 20 }, (_, i) => `worker-${String(i)}`)).length).toBeLessThanOrEqual(80)
  })

  it('notes the sessions a row works for, and nothing for none', () => {
    expect(promptedByNote(['Orchestrator'])).toBe('← Orchestrator')
    expect(promptedByNote(['Orchestrator', 'Reviewer'])).toBe('← Orchestrator, Reviewer')
    expect(promptedByNote([])).toBeUndefined()
  })
})
