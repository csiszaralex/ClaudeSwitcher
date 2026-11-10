import { open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from './guards.js'
import { projectsDir } from './paths.js'
import { toolDetail } from './tool-detail.js'
import type { SessionActivity } from './types.js'

interface ContentBlock {
  type?: unknown
  text?: unknown
  name?: unknown
  input?: unknown
}

function blocks(rec: Record<string, unknown>): ContentBlock[] {
  const message = rec['message']
  if (!isRecord(message)) return []
  const content = message['content']
  if (!Array.isArray(content)) return []
  // Non-object items are dropped here, not in the caller. A `null` block is valid JSON, and reading
  // `.type` on it would throw a TypeError: exactly the kind of crash this module must prevent.
  return content.filter(
    (block): block is ContentBlock => typeof block === 'object' && block !== null,
  )
}

/**
 * Reads from the transcript's last lines what the session is doing now. An unknown record type is
 * skipped silently: the format grows, and a new type must not break the monitor.
 */
export function readActivityFromLines(lines: string[]): SessionActivity {
  const activity: SessionActivity = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    let rec: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!isRecord(parsed)) continue
      rec = parsed
    } catch {
      continue
    }

    const at = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : NaN
    if (!Number.isNaN(at)) activity.lastEventAt = at

    if (rec['type'] === 'assistant') {
      for (const block of blocks(rec)) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          activity.lastAssistantText = block.text.trim()
        }
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          activity.runningTool = block.name
          // The detail belongs to the same block: a new tool without a detail must not inherit the previous one's.
          activity.toolDetail = toolDetail(block.input)
        }
      }
    } else if (rec['type'] === 'user') {
      // A tool_result ends the running tool.
      if (blocks(rec).some((b) => b.type === 'tool_result')) {
        activity.runningTool = undefined
        activity.toolDetail = undefined
      }
    }
  }

  return activity
}

/**
 * Finds the session's transcript. It searches every project directory on purpose instead of
 * deriving the directory name from the cwd: that encoding is undocumented and may change.
 */
export async function findTranscriptPath(
  claudeDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const projects = projectsDir(claudeDir)
  let entries: string[]
  try {
    entries = await readdir(projects)
  } catch {
    return undefined
  }

  for (const entry of entries) {
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`)
    try {
      const handle = await open(candidate, 'r')
      try {
        // Opening is not enough: a *directory* named `<sessionId>.jsonl` opens too, and tailLines
        // then returns nothing or fails with EISDIR. The type has to be checked as well.
        if ((await handle.stat()).isFile()) return candidate
      } finally {
        await handle.close()
      }
    } catch {
      // Missing or unreadable. The two are not told apart: the return contract is
      // `string | undefined`, and a permission error also means this transcript cannot be read.
      continue
    }
  }
  return undefined
}

/** Reads the file's last `maxBytes` bytes and drops the first, partial line. */
export async function tailLines(filePath: string, maxBytes = 256 * 1024): Promise<string[]> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length === 0) return []

    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines
  } catch (error) {
    // An I/O error or an allocation failure must not propagate: the caller (e.g. scanSessions)
    // works best-effort. The allocation failure can only be triggered by a synthetic test.
    console.error(`[transcript] tailLines failed for ${filePath}`, error)
    return []
  } finally {
    await handle.close()
  }
}
