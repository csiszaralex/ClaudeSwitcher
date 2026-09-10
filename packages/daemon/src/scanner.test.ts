import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProcessProbe } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
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

  it('still returns the session when its transcript is unreadable', async () => {
    // Egy olvashatatlan transcript nem tüntetheti el a sessiont a listáról.
    const dir = await fixture()
    const projectDir = path.join(dir, 'projects', 'encoded-alpha')
    await rm(path.join(projectDir, 'sid-100.jsonl'))
    await mkdir(path.join(projectDir, 'sid-100.jsonl'))

    const { sessions, activities } = await scanSessions(dir, aliveProbe)
    expect(sessions).toHaveLength(1)
    expect(activities.get('sid-100')).toEqual({})
  })
})
