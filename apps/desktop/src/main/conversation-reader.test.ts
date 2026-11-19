import type { ConversationEntry } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import { createConversationReader } from './conversation-reader.js'

const ID = '2c4e6a8b-1d3f-4e5a-9b7c-0d2e4f6a8b1c'
const FILE = String.raw`p:\claude\projects\p--proj-alpha\2c4e6a8b-1d3f-4e5a-9b7c-0d2e4f6a8b1c.jsonl`
const ENTRIES: ConversationEntry[] = [{ kind: 'prompt', text: 'Szia.', images: 0, truncated: false }]

function fakeDeps() {
  const stats = { size: 100, mtimeMs: 1000 }
  const deps = {
    isLiveSession: vi.fn((sessionId: string) => sessionId === ID),
    findPath: vi.fn<(sessionId: string) => Promise<string | undefined>>(() => Promise.resolve(FILE)),
    stat: vi.fn<(file: string) => Promise<{ size: number; mtimeMs: number } | undefined>>(() => Promise.resolve({ ...stats })),
    read: vi.fn<(file: string) => Promise<ConversationEntry[] | undefined>>(() => Promise.resolve(ENTRIES)),
  }
  return { deps, stats }
}

describe('createConversationReader', () => {
  it('reads a live session through core, with the transcript version', async () => {
    const { deps } = fakeDeps()
    const reply = await createConversationReader(deps)(ID)
    expect(reply).toEqual({ ok: true, version: '100:1000', entries: ENTRIES })
    expect(deps.read).toHaveBeenCalledWith(FILE)
  })

  it('refuses an id that no live session has, without touching a file', async () => {
    const { deps } = fakeDeps()
    expect(await createConversationReader(deps)('../../x')).toEqual({ ok: false, reason: 'unknown-session' })
    expect(deps.findPath).not.toHaveBeenCalled()
    expect(deps.read).not.toHaveBeenCalled()
  })

  it('keeps the last reply while the transcript stays the same, and reads again once it changes', async () => {
    const { deps, stats } = fakeDeps()
    const read = createConversationReader(deps)
    const first = await read(ID)
    expect(await read(ID)).toBe(first)
    expect(deps.findPath).toHaveBeenCalledOnce()
    expect(deps.read).toHaveBeenCalledOnce()
    stats.size = 200
    deps.stat.mockResolvedValue({ ...stats })
    expect(await read(ID)).toMatchObject({ ok: true, version: '200:1000' })
    expect(deps.read).toHaveBeenCalledTimes(2)
  })

  it('searches again when the kept path is gone', async () => {
    const moved = String.raw`p:\claude\projects\p--proj-beta\2c4e6a8b-1d3f-4e5a-9b7c-0d2e4f6a8b1c.jsonl`
    const { deps } = fakeDeps()
    const read = createConversationReader(deps)
    await read(ID)
    deps.stat.mockImplementation((file: string) => Promise.resolve(file === moved ? { size: 1, mtimeMs: 2 } : undefined))
    deps.findPath.mockResolvedValue(moved)
    expect(await read(ID)).toMatchObject({ ok: true, version: '1:2' })
    expect(deps.read).toHaveBeenLastCalledWith(moved)
  })

  it('says missing for a session without a transcript, and unreadable when core cannot read it', async () => {
    const none = fakeDeps()
    none.deps.findPath.mockResolvedValue(undefined)
    expect(await createConversationReader(none.deps)(ID)).toEqual({ ok: false, reason: 'missing' })
    const broken = fakeDeps()
    broken.deps.read.mockResolvedValue(undefined)
    const read = createConversationReader(broken.deps)
    expect(await read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    // A failed read is not kept: the next ask reads again.
    expect(await read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    expect(broken.deps.read).toHaveBeenCalledTimes(2)
  })

  it('reads another session afresh', async () => {
    const other = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'
    const { deps } = fakeDeps()
    deps.isLiveSession.mockReturnValue(true)
    const read = createConversationReader(deps)
    await read(ID)
    await read(other)
    expect(deps.findPath).toHaveBeenLastCalledWith(other)
    expect(deps.read).toHaveBeenCalledTimes(2)
  })
})
