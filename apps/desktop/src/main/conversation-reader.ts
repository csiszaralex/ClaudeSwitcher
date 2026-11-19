import type { ConversationEntry } from '@claudeswitcher/core'
import type { ConversationReply } from '../shared/overlay-channels.js'

/** What the reader needs from the file system and from core; injected so it can be tested. */
export interface ConversationReaderDeps {
  /** Whether a live session has the id: only those are read (the id comes from the renderer). */
  isLiveSession: (sessionId: string) => boolean
  /** Core `findTranscriptPath`. */
  findPath: (sessionId: string) => Promise<string | undefined>
  /** The transcript's size and last write, `undefined` when it cannot be read. */
  stat: (file: string) => Promise<{ size: number; mtimeMs: number } | undefined>
  /** Core `readTranscriptConversation`. */
  read: (file: string) => Promise<ConversationEntry[] | undefined>
}

/**
 * The peek's reader (`OVERLAY_CHANNELS.conversation`): a live session's recent conversation, read
 * from its transcript by core. The renderer asks every second while the peek is open, so it keeps
 * the last reply: while the transcript's size and last write stay the same, it neither searches for
 * the file again nor reads it. One session at a time, as the peek shows one.
 */
export function createConversationReader(deps: ConversationReaderDeps): (sessionId: string) => Promise<ConversationReply> {
  let last: { sessionId: string; file: string; reply: ConversationReply & { ok: true } } | undefined

  return async (sessionId) => {
    if (!deps.isLiveSession(sessionId)) return { ok: false, reason: 'unknown-session' }
    let file = last?.sessionId === sessionId ? last.file : await deps.findPath(sessionId)
    let info = file === undefined ? undefined : await deps.stat(file)
    if (info === undefined && last?.sessionId === sessionId) {
      // The kept path is gone (the transcript moved): search once more.
      file = await deps.findPath(sessionId)
      info = file === undefined ? undefined : await deps.stat(file)
    }
    if (file === undefined || info === undefined) {
      last = undefined
      return { ok: false, reason: 'missing' }
    }
    const version = `${String(info.size)}:${String(info.mtimeMs)}`
    if (last?.sessionId === sessionId && last.file === file && last.reply.version === version) return last.reply
    const entries = await deps.read(file)
    if (entries === undefined) {
      last = undefined
      return { ok: false, reason: 'unreadable' }
    }
    const reply = { ok: true as const, version, entries }
    last = { sessionId, file, reply }
    return reply
  }
}
