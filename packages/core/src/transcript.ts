import { open, readdir, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { createPromptTracker, isTurnEnd, mayConcernPrompts } from './cross-session.js'
import { isRecord } from './guards.js'
import { projectsDir } from './paths.js'
import { toolDetail } from './tool-detail.js'
import { shownTabTitle, titleRecordOf, type TitlesSeen } from './tab-title.js'
import type { SessionActivity } from './types.js'
import { isApiErrorRecord, usageLimitOf } from './usage-limit.js'

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
  // Items that are not records are dropped here, not in the caller. A `null` block is valid JSON, and
  // reading `.type` on it would throw a TypeError: exactly the kind of crash this module must prevent.
  return content.filter(isRecord)
}

/** A transcript line as a record, or `undefined` for an empty, broken or non-object line. Never throws. */
function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Whether a raw line ends a turn (`cross-session.ts` `isTurnEnd`), parsing only a line that may (`mayConcernPrompts`). */
function isTurnEndLine(line: string): boolean {
  if (!mayConcernPrompts(line)) return false
  const rec = parseLine(line)
  return rec !== undefined && isTurnEnd(rec)
}

/**
 * Reads from the transcript's last lines what the session is doing now. An unknown record type is
 * skipped silently: the format grows, and a new type must not break the monitor.
 *
 * @param earlierLines lines from before `lines`, in file order, that only the senders the session
 * works for (`promptedBy`) are read from: a turn can outgrow the tail (`readTranscriptActivity`).
 */
export function readActivityFromLines(lines: readonly string[], earlierLines: readonly string[] = []): SessionActivity {
  const activity: SessionActivity = {}
  const titles: TitlesSeen = {}
  const prompts = createPromptTracker()

  for (const line of earlierLines) {
    const rec = parseLine(line)
    if (rec !== undefined) prompts.see(rec)
  }

  for (const line of lines) {
    const rec = parseLine(line)
    if (rec === undefined) continue
    prompts.see(rec)

    const at = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : NaN
    if (!Number.isNaN(at)) activity.lastEventAt = at

    const titled = titleRecordOf(rec)
    if (titled !== undefined) {
      titles[titled.source] = titled.title
      continue
    }

    if (rec['type'] === 'assistant') {
      const limit = usageLimitOf(rec)
      if (limit !== undefined) {
        // Claude Code's synthetic limit record. Its English text ("You've hit your 5-hour limit …")
        // must not become the row's text: the renderer shows the limit in its own words.
        activity.usageLimit = limit
        continue
      }
      // Any other error record (a server or an authentication error) keeps its text, as before: it
      // says what went wrong. A real answer means the session got through again.
      if (!isApiErrorRecord(rec)) activity.usageLimit = undefined
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
      // A user record after the limit is a new prompt (or a tool result): the session goes on.
      activity.usageLimit = undefined
      // A tool_result ends the running tool.
      if (blocks(rec).some((b) => b.type === 'tool_result')) {
        activity.runningTool = undefined
        activity.toolDetail = undefined
      }
    }
  }

  const tabTitle = shownTabTitle(titles)
  if (tabTitle !== undefined) activity.tabTitle = tabTitle
  const promptedBy = prompts.senders()
  if (promptedBy.length > 0) activity.promptedBy = promptedBy
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

/** The tail a session's activity is read from (`tailLines`' default, `readTranscriptActivity`). */
const TAIL_BYTES = 256 * 1024

/**
 * How far before the tail `readTranscriptActivity` looks for the start of a turn that outgrew it.
 * Measured (2026-11-19, 611 deliveries, design doc "Cross-session messages"): between the delivery
 * of a cross-session message and the end of the turn that handles it, a transcript grew by 53 KB at
 * the median, 748 KB at p90, 4.7 MB at p99 and 9.0 MB at most; 138 of them outgrew the 256 KB tail.
 * A lookback of the whole 16 MB took 19 ms (a synthetic 17 MB transcript without a turn end).
 */
const PROMPT_LOOKBACK_BYTES = 16 * 1024 * 1024

/** The piece `readTranscriptActivity` reads at a time when it looks back. */
const LOOKBACK_CHUNK_BYTES = 1024 * 1024

const NEWLINE = 0x0a

interface Tail {
  /** The complete lines of the tail. */
  lines: string[]
  /** Where the tail starts in the file. */
  start: number
  /** The bytes before the tail's first newline: the end of a line that starts before `start` (empty at the file's start). */
  head: Buffer
}

/** Reads the last `maxBytes` bytes and splits off the first, partial line. Throws on an I/O error. */
async function readTail(handle: FileHandle, maxBytes: number): Promise<Tail> {
  const { size } = await handle.stat()
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  if (length === 0) return { lines: [], start, head: Buffer.alloc(0) }

  const buffer = Buffer.alloc(length)
  await handle.read(buffer, 0, length, start)
  if (start === 0) return { lines: buffer.toString('utf8').split('\n'), start, head: Buffer.alloc(0) }
  // A newline byte never occurs inside a multi-byte UTF-8 character, so the split is safe on bytes.
  const newline = buffer.indexOf(NEWLINE)
  if (newline === -1) return { lines: [], start, head: buffer }
  return { lines: buffer.subarray(newline + 1).toString('utf8').split('\n'), start, head: buffer.subarray(0, newline) }
}

/**
 * The lines before `end` that may concern a cross-session message (`mayConcernPrompts`), in file
 * order, back to the last turn end (`isTurnEndLine`) or at most `limit` bytes. `head` is the end of
 * the line that runs across `end`. Reads `LOOKBACK_CHUNK_BYTES` at a time, from the end backwards.
 */
async function promptLinesBefore(handle: FileHandle, end: number, head: Buffer, limit: number): Promise<string[]> {
  const floor = Math.max(0, end - limit)
  const chunks: string[][] = []
  let carry = head
  let pos = end
  while (pos > floor) {
    const start = Math.max(floor, pos - LOOKBACK_CHUNK_BYTES)
    const buffer = Buffer.alloc(pos - start)
    await handle.read(buffer, 0, buffer.length, start)
    const joined = Buffer.concat([buffer, carry])
    pos = start
    let from = 0
    if (start > 0) {
      // The bytes up to the first newline belong to a line that starts in the next piece back.
      const newline = joined.indexOf(NEWLINE)
      if (newline === -1) {
        carry = joined
        continue
      }
      carry = joined.subarray(0, newline)
      from = newline + 1
    }
    const lines = joined.subarray(from).toString('utf8').split('\n').filter(mayConcernPrompts)
    chunks.unshift(lines)
    if (lines.some(isTurnEndLine)) break
  }
  return chunks.flat()
}

/**
 * The session's activity from its transcript (`readActivityFromLines`): the last 256 KB
 * (`TAIL_BYTES`), and, when they hold no turn end, the lines before them back to the last one
 * (`promptLinesBefore`, at most `lookbackBytes`), for the senders the running turn works for. Only
 * the lines that may concern a cross-session message are kept from there. Never throws.
 */
export async function readTranscriptActivity(
  filePath: string,
  lookbackBytes: number = PROMPT_LOOKBACK_BYTES,
): Promise<SessionActivity> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return {}
  }
  try {
    const tail = await readTail(handle, TAIL_BYTES)
    const earlier =
      tail.start > 0 && !tail.lines.some(isTurnEndLine)
        ? await promptLinesBefore(handle, tail.start, tail.head, lookbackBytes)
        : []
    return readActivityFromLines(tail.lines, earlier)
  } catch (error) {
    // Best-effort like `tailLines`: the scan goes on with what the other sessions give.
    console.error(`[transcript] readTranscriptActivity failed for ${filePath}`, error)
    return {}
  } finally {
    await handle.close()
  }
}

/** Reads the file's last `maxBytes` bytes and drops the first, partial line. */
export async function tailLines(filePath: string, maxBytes = TAIL_BYTES): Promise<string[]> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return []
  }
  try {
    return (await readTail(handle, maxBytes)).lines
  } catch (error) {
    // An I/O error or an allocation failure must not propagate: the caller (e.g. scanSessions)
    // works best-effort. The allocation failure can only be triggered by a synthetic test.
    console.error(`[transcript] tailLines failed for ${filePath}`, error)
    return []
  } finally {
    await handle.close()
  }
}
