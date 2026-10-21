import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProcessProbe } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import { scanSessions } from './scanner.js'

// A ProcessProbe-nak `imageName`-je is van a Task 3 óta: a lock fájlok nem
// tárolnak `procStart`-ot, így csak az image név árulja el, ha egy elárvult lock
// pidjét időközben egy másik processz kapta meg.
const aliveProbe: ProcessProbe = { isAlive: () => true, imageName: () => 'Code' }
const deadProbe: ProcessProbe = { isAlive: () => false, imageName: () => undefined }

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cs-scan-'))
  await mkdir(path.join(dir, 'sessions'), { recursive: true })
  await mkdir(path.join(dir, 'ide'), { recursive: true })
  await mkdir(path.join(dir, 'projects', 'encoded-alpha'), { recursive: true })

  await writeFile(
    path.join(dir, 'sessions', '100.json'),
    JSON.stringify({
      pid: 100, sessionId: 'sid-100', cwd: 'p:\\proj\\alpha',
      startedAt: 1, procStart: 'ps-100', name: 'alpha-01',
    }),
  )
  // Szemét, ami nem session fájl — nem szabad elszállni rajta.
  await writeFile(path.join(dir, 'sessions', '100.abc123'), JSON.stringify({ peerToken: 'x' }))
  await writeFile(path.join(dir, 'sessions', 'broken.json'), '{ not json')

  await writeFile(
    path.join(dir, 'ide', '50269.lock'),
    JSON.stringify({ pid: 900, workspaceFolders: ['p:\\proj\\alpha'], transport: 'ws' }),
  )

  await writeFile(
    path.join(dir, 'projects', 'encoded-alpha', 'sid-100.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-04T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    }) + '\n',
  )
  return dir
}

describe('scanSessions', () => {
  it('finds live sessions, pairs windows, and reads activity', async () => {
    const dir = await fixture()
    const { sessions, activities } = await scanSessions(dir, aliveProbe)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.record.sessionId).toBe('sid-100')
    expect(sessions[0]!.window?.pid).toBe(900)
    expect(activities.get('sid-100')?.runningTool).toBe('Bash')
  })

  it('returns nothing when no process is alive', async () => {
    const dir = await fixture()
    const { sessions } = await scanSessions(dir, deadProbe)
    expect(sessions).toEqual([])
  })

  it('survives a missing claude directory', async () => {
    const { sessions, activities } = await scanSessions(
      path.join(tmpdir(), 'cs-does-not-exist'),
      aliveProbe,
    )
    expect(sessions).toEqual([])
    expect(activities.size).toBe(0)
  })

  it('derives the lock port from the filename', async () => {
    const dir = await fixture()
    const { sessions } = await scanSessions(dir, aliveProbe)
    expect(sessions[0]!.window?.port).toBe(50269)
  })

  it('still returns the session when its transcript is not a readable file', async () => {
    // Figyelem: ez a `findTranscriptPath` isFile() védőágán megy át, nem a
    // scanner catch blokkján — az utóbbi védelem mélységben, és nincs rá
    // platformfüggetlen kiváltó. Amit ez bizonyít, az önmagában is fontos: egy
    // hiányzó vagy hibás transcript nem tünteti el a sessiont a listáról.
    const dir = await fixture()
    const projectDir = path.join(dir, 'projects', 'encoded-alpha')
    await rm(path.join(projectDir, 'sid-100.jsonl'))
    await mkdir(path.join(projectDir, 'sid-100.jsonl'))

    const { sessions, activities } = await scanSessions(dir, aliveProbe)
    expect(sessions).toHaveLength(1)
    expect(activities.get('sid-100')).toEqual({})
  })
})

// Konstruált subagent-fájlok a mért alakban (Claude Code 2.1.30x, 2026-10-21) — nem valódi tartalom.
function subagentLine(tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    agentId: 'x',
    isSidechain: true,
    sessionId: 'sid-100',
    timestamp: '2026-10-21T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', name: tool, input }] },
  })
}

async function addSubagent(
  dir: string,
  agentId: string,
  opts: { meta?: string | Record<string, unknown> | undefined; lines?: string[]; ageMs?: number },
): Promise<void> {
  const sub = path.join(dir, 'projects', 'encoded-alpha', 'sid-100', 'subagents')
  await mkdir(sub, { recursive: true })
  const jsonl = path.join(sub, `agent-${agentId}.jsonl`)
  const noise = JSON.stringify({ type: 'api-request', agentId, isSidechain: true })
  await writeFile(jsonl, [noise, ...(opts.lines ?? [])].join('\n') + '\n')
  if (opts.meta !== undefined) {
    const meta = typeof opts.meta === 'string' ? opts.meta : JSON.stringify(opts.meta)
    await writeFile(path.join(sub, `agent-${agentId}.meta.json`), meta)
  }
  const at = (Date.now() - (opts.ageMs ?? 0)) / 1000
  await utimes(jsonl, at, at)
}

const runningMeta = { agentType: 'general-purpose', description: 'Teszt hullám', toolUseId: 'toolu_c1', spawnDepth: 1 }

describe('scanSessions — subagents', () => {
  it('reports an active subagent with its running tool and detail', async () => {
    const dir = await fixture()
    await addSubagent(dir, 'a1', { meta: runningMeta, lines: [subagentLine('Grep', { pattern: 'createPanel' })] })

    const { subagents } = await scanSessions(dir, aliveProbe)
    const list = subagents.get('sid-100') ?? []
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      agentId: 'a1',
      agentType: 'general-purpose',
      description: 'Teszt hullám',
      runningTool: 'Grep',
      toolDetail: 'createPanel',
    })
    expect(Math.abs((list[0]?.updatedAt ?? 0) - Date.now())).toBeLessThan(60_000)
  })

  it('leaves out a finished subagent', async () => {
    const dir = await fixture()
    await addSubagent(dir, 'a1', { meta: { ...runningMeta, finished: true }, lines: [subagentLine('Bash', { command: 'x' })] })
    expect((await scanSessions(dir, aliveProbe)).subagents.get('sid-100') ?? []).toEqual([])
  })

  it('leaves out a stale subagent that never wrote finished (crashed)', async () => {
    const dir = await fixture()
    await addSubagent(dir, 'a1', { meta: runningMeta, lines: [subagentLine('Bash', { command: 'x' })], ageMs: 6 * 60_000 })
    expect((await scanSessions(dir, aliveProbe)).subagents.get('sid-100') ?? []).toEqual([])
  })

  it('looks at no more than the three most recently written subagents, newest first', async () => {
    const dir = await fixture()
    for (const [i, id] of ['a0', 'a1', 'a2', 'a3', 'a4'].entries()) {
      await addSubagent(dir, id, { meta: runningMeta, lines: [subagentLine('Bash', { command: id })], ageMs: i * 10_000 })
    }
    const list = (await scanSessions(dir, aliveProbe)).subagents.get('sid-100') ?? []
    expect(list.map((s) => s.agentId)).toEqual(['a0', 'a1', 'a2'])
  })

  it('does not let newer finished subagents hide an older active one', async () => {
    // A korlát a KÉSZ subagentek kiszűrése UTÁN hat: három frissen befejezett subagent nem
    // takarhatja el a még futót, csak mert azok később írtak.
    const dir = await fixture()
    for (const [i, id] of ['done0', 'done1', 'done2'].entries()) {
      await addSubagent(dir, id, {
        meta: { ...runningMeta, finished: true },
        lines: [subagentLine('Bash', { command: id })],
        ageMs: i * 1_000,
      })
    }
    await addSubagent(dir, 'live', { meta: runningMeta, lines: [subagentLine('Grep', { pattern: 'x' })], ageMs: 30_000 })
    const list = (await scanSessions(dir, aliveProbe)).subagents.get('sid-100') ?? []
    expect(list.map((s) => s.agentId)).toEqual(['live'])
  })

  it('treats a missing subagents directory as normal, without logging', async () => {
    const dir = await fixture()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { subagents } = await scanSessions(dir, aliveProbe)
      expect(subagents.get('sid-100') ?? []).toEqual([])
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('keeps a subagent whose meta is missing or broken, without its labels, and logs the broken one once', async () => {
    const dir = await fixture()
    await addSubagent(dir, 'nometa', { lines: [subagentLine('Read', { file_path: 'P:\\a\\b.ts' })] })
    await addSubagent(dir, 'broken', { meta: '{ not json', lines: [subagentLine('Bash', { command: 'ls' })], ageMs: 1_000 })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const first = (await scanSessions(dir, aliveProbe)).subagents.get('sid-100') ?? []
      await scanSessions(dir, aliveProbe)
      expect(first.map((s) => [s.agentId, s.runningTool, s.agentType])).toEqual([
        ['nometa', 'Read', undefined],
        ['broken', 'Bash', undefined],
      ])
      expect(errorSpy).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('skips a directory that carries a subagent transcript name', async () => {
    const dir = await fixture()
    await addSubagent(dir, 'a1', { meta: runningMeta, lines: [subagentLine('Bash', { command: 'x' })] })
    await mkdir(path.join(dir, 'projects', 'encoded-alpha', 'sid-100', 'subagents', 'agent-dir.jsonl'))
    const list = (await scanSessions(dir, aliveProbe)).subagents.get('sid-100') ?? []
    expect(list.map((s) => s.agentId)).toEqual(['a1'])
  })
})
