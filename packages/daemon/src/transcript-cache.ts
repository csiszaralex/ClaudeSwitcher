import { stat } from 'node:fs/promises'
import { findTranscriptPath, readTranscriptActivity, type SessionActivity } from '@claudeswitcher/core'

/** A session's main transcript and the activity read from it. */
interface TranscriptReading {
  transcript: string
  activity: SessionActivity
}

/**
 * How `scanSessions` gets a session's transcript and activity. `retain` gets the ids of the sessions
 * the scan listed, after their reads, so a reader that remembers something can forget the others.
 */
export interface TranscriptReader {
  read(claudeDir: string, sessionId: string): Promise<TranscriptReading | undefined>
  retain(sessionIds: ReadonlySet<string>): void
}

/** Searches and reads on every call (core `findTranscriptPath`, `readTranscriptActivity`); remembers nothing. */
export const uncachedTranscripts: TranscriptReader = {
  async read(claudeDir, sessionId) {
    const transcript = await findTranscriptPath(claudeDir, sessionId)
    if (transcript === undefined) return undefined
    return { transcript, activity: await readTranscriptActivity(transcript) }
  },
  retain() {
    // Nothing is remembered.
  },
}

interface Entry {
  transcript: string
  size: number
  mtimeMs: number
  activity: SessionActivity
}

/** The file's size and last write, or `undefined` when it is not a readable file. Never throws. */
async function fileVersion(filePath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(filePath)
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

/**
 * A `TranscriptReader` that remembers, per session, the transcript's path, its size and last write
 * (`mtimeMs`), and the activity read from it. The next read costs one `stat` of the remembered path:
 * the same size and last write give back the remembered activity, without searching every project
 * folder (`findTranscriptPath`) or reading the tail again (`readTranscriptActivity`); a change reads
 * again; a failed `stat` (the file moved or was deleted) searches again.
 *
 * This is exact because `readActivityFromLines` depends only on the lines it gets: no clock, no
 * other session. The `stat` comes before the read, so a write in between leaves an older size or
 * time in the entry, and the next scan reads again. An empty activity is never remembered:
 * `readTranscriptActivity` returns `{}` on a read error too, and a remembered failure would stay
 * until the next write, while a read that is not remembered is tried again on the next scan.
 *
 * One known difference to searching every time: when a second file of the same session appears in
 * another project folder while the remembered one still exists, the remembered one is kept, where
 * `findTranscriptPath` would return the first folder in `readdir` order.
 */
export function createTranscriptCache(): TranscriptReader {
  const entries = new Map<string, Entry>()

  async function readFresh(transcript: string): Promise<{ entry: Entry | undefined; activity: SessionActivity }> {
    const version = await fileVersion(transcript)
    const activity = await readTranscriptActivity(transcript)
    const entry = version !== undefined && Object.keys(activity).length > 0 ? { transcript, ...version, activity } : undefined
    return { entry, activity }
  }

  return {
    async read(claudeDir, sessionId) {
      const known = entries.get(sessionId)
      let transcript: string | undefined
      if (known !== undefined) {
        const version = await fileVersion(known.transcript)
        if (version?.size === known.size && version.mtimeMs === known.mtimeMs) {
          return { transcript: known.transcript, activity: known.activity }
        }
        // Changed: read the same file again. Gone or not a file: search again.
        if (version !== undefined) transcript = known.transcript
      }
      transcript ??= await findTranscriptPath(claudeDir, sessionId)
      if (transcript === undefined) {
        entries.delete(sessionId)
        return undefined
      }
      const { entry, activity } = await readFresh(transcript)
      if (entry === undefined) entries.delete(sessionId)
      else entries.set(sessionId, entry)
      return { transcript, activity }
    },
    retain(sessionIds) {
      for (const id of entries.keys()) if (!sessionIds.has(id)) entries.delete(id)
    },
  }
}
