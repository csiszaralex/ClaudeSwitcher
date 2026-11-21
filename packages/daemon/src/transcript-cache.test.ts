import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fakeProbe, tempDir, writeSessionRecord } from '@claudeswitcher/core/testing'
import { describe, expect, it } from 'vitest'
import { scanSessions } from './scanner.js'
import { createTranscriptCache, uncachedTranscripts } from './transcript-cache.js'

// Invented transcript lines in the measured shape: one tool call each, the tool's name the only difference.
function toolLine(tool: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-04T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', name: tool, input: {} }] },
  })
}

/** A fixed last write (whole seconds, so the file system keeps it exactly). */
const FIXED_TIME = 1_788_000_000

/**
 * Writes the transcript and sets its last write to `FIXED_TIME`, so a rewrite of the same size can
 * look unchanged to the cache. `Grep` and `Read` have the same length on purpose.
 */
async function writeTranscript(file: string, tool: string): Promise<void> {
  await writeFile(file, `${toolLine(tool)}\n`)
  await utimes(file, FIXED_TIME, FIXED_TIME)
}

async function fixture(): Promise<{ dir: string; file: string }> {
  const dir = await tempDir('cs-cache-')
  await writeSessionRecord(dir)
  await mkdir(path.join(dir, 'projects', 'encoded-alpha'), { recursive: true })
  const file = path.join(dir, 'projects', 'encoded-alpha', 'sid-100.jsonl')
  await writeTranscript(file, 'Grep')
  return { dir, file }
}

describe('createTranscriptCache', () => {
  it('reuses the reading while the size and the last write stay the same', async () => {
    const { dir, file } = await fixture()
    const cache = createTranscriptCache()
    expect((await cache.read(dir, 'sid-100'))?.activity.runningTool).toBe('Grep')
    // Different content, same size and last write: only a remembered reading still says Grep.
    await writeTranscript(file, 'Read')
    expect(await cache.read(dir, 'sid-100')).toMatchObject({ transcript: file, activity: { runningTool: 'Grep' } })
    expect((await uncachedTranscripts.read(dir, 'sid-100'))?.activity.runningTool).toBe('Read')
  })

  it('reads a changed transcript again', async () => {
    const { dir, file } = await fixture()
    const cache = createTranscriptCache()
    await cache.read(dir, 'sid-100')
    await writeFile(file, `${toolLine('Grep')}\n${toolLine('Bash')}\n`)
    expect((await cache.read(dir, 'sid-100'))?.activity.runningTool).toBe('Bash')
  })

  it('finds a moved transcript again', async () => {
    const { dir, file } = await fixture()
    const cache = createTranscriptCache()
    await cache.read(dir, 'sid-100')
    const moved = path.join(dir, 'projects', 'encoded-beta', 'sid-100.jsonl')
    await mkdir(path.dirname(moved), { recursive: true })
    await rename(file, moved)
    expect(await cache.read(dir, 'sid-100')).toMatchObject({ transcript: moved, activity: { runningTool: 'Grep' } })
  })

  it('returns nothing once the transcript is gone', async () => {
    const { dir, file } = await fixture()
    const cache = createTranscriptCache()
    await cache.read(dir, 'sid-100')
    await rm(file)
    expect(await cache.read(dir, 'sid-100')).toBeUndefined()
  })

  it('forgets a session that retain does not name', async () => {
    const { dir, file } = await fixture()
    const cache = createTranscriptCache()
    await cache.read(dir, 'sid-100')
    cache.retain(new Set(['sid-other']))
    // Unchanged to the cache, so only a forgotten entry reads the new content.
    await writeTranscript(file, 'Read')
    expect((await cache.read(dir, 'sid-100'))?.activity.runningTool).toBe('Read')
  })

  it('keeps a session that retain names', async () => {
    const { dir, file } = await fixture()
    const cache = createTranscriptCache()
    await cache.read(dir, 'sid-100')
    cache.retain(new Set(['sid-100']))
    await writeTranscript(file, 'Read')
    expect((await cache.read(dir, 'sid-100'))?.activity.runningTool).toBe('Grep')
  })

  it('does not remember an empty reading', async () => {
    // `readTranscriptActivity` returns `{}` on a read error too; such a reading must be tried again.
    // A line that is not JSON reads as `{}`; it has the same length as the tool line after it.
    const { dir, file } = await fixture()
    await writeFile(file, `${' '.repeat(toolLine('Bash').length)}
`)
    await utimes(file, FIXED_TIME, FIXED_TIME)
    const cache = createTranscriptCache()
    expect((await cache.read(dir, 'sid-100'))?.activity).toEqual({})
    await writeTranscript(file, 'Bash')
    expect((await cache.read(dir, 'sid-100'))?.activity.runningTool).toBe('Bash')
  })
})

describe('scanSessions with the transcript cache', () => {
  it('gives the same output as without it, on the first scan and on a repeated one', async () => {
    const { dir } = await fixture()
    const probe = fakeProbe()
    const now = Date.now()
    const cache = createTranscriptCache()
    const plain = await scanSessions(dir, probe, now)
    expect(await scanSessions(dir, probe, now, new Set(), cache)).toEqual(plain)
    expect(await scanSessions(dir, probe, now, new Set(), cache)).toEqual(plain)
  })
})
