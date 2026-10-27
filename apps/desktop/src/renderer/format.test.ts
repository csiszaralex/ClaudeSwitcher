import { describe, expect, it } from 'vitest'
import { formatDuration, pendingRowText, subagentLabel, subagentTooltip, summarize, toolLabel } from './format.js'

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45mp')
  })

  it('renders minutes and seconds', () => {
    expect(formatDuration(134_000)).toBe('2:14')
  })

  it('renders hours', () => {
    expect(formatDuration(3_700_000)).toBe('1:01:40')
  })

  it('clamps a negative duration to zero', () => {
    expect(formatDuration(-5)).toBe('0mp')
  })
})

describe('summarize', () => {
  it('prefers the notification text when waiting', () => {
    const line = summarize({
      status: 'waiting',
      notificationText: 'Claude needs permission to run pnpm test',
      activity: { runningTool: 'Bash' },
    })
    expect(line).toBe('Claude needs permission to run pnpm test')
  })

  it('names the running tool when working', () => {
    expect(summarize({ status: 'working', activity: { runningTool: 'Bash' } })).toBe('Bash fut')
  })

  it('shows the last assistant text when idle', () => {
    expect(summarize({ status: 'idle', activity: { lastAssistantText: 'Kész.' } })).toBe('Kész.')
  })

  it('truncates a long summary', () => {
    const long = 'x'.repeat(200)
    expect(summarize({ status: 'idle', activity: { lastAssistantText: long } }).length).toBe(80)
  })

  it('falls back when there is nothing to say', () => {
    expect(summarize({ status: 'idle', activity: {} })).toBe('—')
  })

  it('survives a session whose activity is missing entirely', () => {
    // A daemon a típus szerint mindig ad `activity`-t, de egy hibás üzenet nem. Ez
    // renderelés közben dobna, és az egész overlay eltűnne.
    const broken = { status: 'idle' } as unknown as Parameters<typeof summarize>[0]
    expect(() => summarize(broken)).not.toThrow()
    expect(summarize(broken)).toBe('—')
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
    expect(toolLabel('Grep', 'createPanel')).toBe('Grep „createPanel"')
  })
})

describe('summarize — a tool részlete és a subagentek', () => {
  const searching = { agentId: 'a1', description: 'Final-review fix wave', runningTool: 'Grep', toolDetail: 'createPanel', updatedAt: 2 }
  const reading = { agentId: 'a2', agentType: 'Explore', runningTool: 'Read', toolDetail: 'x.ts', updatedAt: 1 }

  it('names what the main session tool works on', () => {
    expect(summarize({ status: 'working', activity: { runningTool: 'Bash', toolDetail: 'pnpm test' } })).toBe('Bash: pnpm test')
  })

  it('shows the work of an active subagent instead of the main session', () => {
    const line = summarize({ status: 'working', activity: { runningTool: 'Agent' }, subagents: [searching] })
    expect(line).toBe('↳ Final-review fix wave · Grep „createPanel"')
  })

  it('shows the most recent subagent and a count of the others', () => {
    const line = summarize({ status: 'idle', activity: {}, subagents: [searching, reading] })
    expect(line).toBe('↳ +1 · Final-review fix wave · Grep „createPanel"')
  })

  it('falls back to the agent type, then to a generic name, and shows a subagent between tools', () => {
    expect(summarize({ status: 'idle', activity: {}, subagents: [reading] })).toBe('↳ Explore · Read „x.ts"')
    expect(summarize({ status: 'idle', activity: {}, subagents: [{ agentId: 'a3', updatedAt: 1 }] })).toBe('↳ subagent')
  })

  it('keeps the notification text of a waiting session over the subagents', () => {
    const line = summarize({ status: 'waiting', notificationText: 'Engedély kell', activity: {}, subagents: [searching] })
    expect(line).toBe('Engedély kell')
  })

  it('ignores an empty subagent list', () => {
    expect(summarize({ status: 'idle', activity: { lastAssistantText: 'Kész.' }, subagents: [] })).toBe('Kész.')
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

describe('pendingRowText', () => {
  it('names the tool and the request in one clipped line, like the other row texts', () => {
    expect(pendingRowText({ toolName: 'Bash', summary: 'git add -A\n  git commit' })).toBe('Bash: git add -A git commit')
    const long = pendingRowText({ toolName: 'Bash', summary: `cat <<END\n${'x'.repeat(100_000)}\nEND` })
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
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
