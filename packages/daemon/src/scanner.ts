import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type LiveSession,
  type ProcessProbe,
  type SessionActivity,
  type SessionRecord,
  type SubagentMeta,
  type SubagentView,
  type IdeLock,
  SUBAGENT_META_LIMIT,
  SUBAGENT_SCAN_LIMIT,
  SUBAGENT_TAIL_BYTES,
  findTranscriptPath,
  ideDir,
  isMissingPathError,
  parseIdeLock,
  parseSessionRecord,
  parseSubagentMeta,
  pickRecentSubagentFiles,
  readActivityFromLines,
  resolveLiveSessions,
  sessionsDir,
  subagentIdFromFile,
  subagentMetaFile,
  subagentsDirOf,
  tailLines,
} from '@claudeswitcher/core'

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function readRecords(claudeDir: string): Promise<SessionRecord[]> {
  const dir = sessionsDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.json'))
  const records = await Promise.all(
    names.map(async (name) => parseSessionRecord(await readJson(path.join(dir, name)))),
  )
  return records.filter((r): r is SessionRecord => r !== null)
}

/** The file's last write (ms), or `undefined` when it cannot be read. Never throws. */
async function mtimeOf(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * The IDE lock files, each with the time of its last write (`mtimeMs`). The time is needed to detect
 * pid reuse (see core `lockPredatesProcess`). Read only: `~/.claude` is not ours, so a stale lock is
 * not deleted either, only not paired.
 */
async function readLocks(claudeDir: string): Promise<IdeLock[]> {
  const dir = ideDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.lock'))
  const locks = await Promise.all(
    names.map(async (name): Promise<IdeLock | null> => {
      const port = Number.parseInt(path.basename(name, '.lock'), 10)
      if (Number.isNaN(port)) return null
      const file = path.join(dir, name)
      const [raw, mtimeMs] = await Promise.all([readJson(file), mtimeOf(file)])
      const lock = parseIdeLock(raw, port)
      return lock === null ? null : { ...lock, mtimeMs }
    }),
  )
  return locks.filter((l): l is IdeLock => l !== null)
}

/**
 * The paths whose error was already reported. The poll runs every 3 seconds: a file that stays
 * unreadable would otherwise fill the log with the same line twenty times a minute.
 */
const reported = new Set<string>()

function reportOnce(filePath: string, what: string, error: unknown): void {
  if (reported.has(filePath)) return
  reported.add(filePath)
  console.error(`[scan] ${what} failed for ${filePath}`, error)
}

async function readSubagentMeta(metaPath: string): Promise<SubagentMeta> {
  let raw: string
  try {
    raw = await readFile(metaPath, 'utf8')
  } catch (error) {
    // A missing meta file: no label, but the subagent may still run; the stale window bounds it.
    if (!isMissingPathError(error)) reportOnce(metaPath, 'subagent meta read', error)
    return { finished: false }
  }
  try {
    return parseSubagentMeta(JSON.parse(raw))
  } catch (error) {
    reportOnce(metaPath, 'subagent meta parse', error)
    return { finished: false }
  }
}

/**
 * The session's active subagents, the most recently written first. Cost per poll: one readdir, one
 * stat for every `agent-*.jsonl` (needed to pick the most recent ones), at most
 * `SUBAGENT_META_LIMIT` meta reads within the stale window, and the transcript tail only for the
 * `SUBAGENT_SCAN_LIMIT` most recent UNFINISHED subagents. Never throws: a faulty file takes only its
 * own subagent with it.
 *
 * @param heldAgents the subagents with a pending decision. They are included regardless of their age
 * and of the limit: a subagent waiting for a permission writes nothing, so after the stale window its
 * label would disappear from the decision panel. The extra cost is at most one meta file and one
 * transcript tail per pending decision.
 */
async function readSubagents(
  transcript: string,
  now: number,
  heldAgents: ReadonlySet<string>,
): Promise<SubagentView[]> {
  const dir = subagentsDirOf(transcript)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    // A missing subagents directory is the normal case, not an error.
    if (!isMissingPathError(error)) reportOnce(dir, 'subagent listing', error)
    return []
  }

  const files = await Promise.all(
    names.map(async (name) => {
      const agentId = subagentIdFromFile(name)
      if (agentId === undefined) return undefined
      const file = path.join(dir, name)
      try {
        const info = await stat(file)
        return info.isFile() ? { agentId, mtimeMs: info.mtimeMs, file } : undefined
      } catch (error) {
        // A file deleted between the readdir and the stat is normal; anything else goes to the log once.
        if (!isMissingPathError(error)) reportOnce(file, 'subagent stat', error)
        return undefined
      }
    }),
  )
  const listed = files.filter((file) => file !== undefined)
  // First filter out the finished subagents, and ONLY then apply the count limit: otherwise a few
  // just-finished subagents would hide one still running (see SUBAGENT_META_LIMIT).
  const recent = pickRecentSubagentFiles(listed, now, SUBAGENT_META_LIMIT)
  const held = listed.filter((file) => heldAgents.has(file.agentId) && !recent.includes(file))
  const withMeta = await Promise.all(
    [...recent, ...held].map(async (candidate) => ({
      ...candidate,
      meta: await readSubagentMeta(path.join(dir, subagentMetaFile(candidate.agentId))),
    })),
  )
  const unfinished = withMeta.filter(({ meta }) => !meta.finished)
  const limited = unfinished.filter(({ agentId }) => !heldAgents.has(agentId)).slice(0, SUBAGENT_SCAN_LIMIT)
  // A subagent with a pending decision stays even beyond the limit; the order is most recently written first.
  const active = unfinished
    .filter((candidate) => heldAgents.has(candidate.agentId) || limited.includes(candidate))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return Promise.all(
    active.map(async ({ agentId, mtimeMs, file, meta }): Promise<SubagentView> => {
      const activity = readActivityFromLines(await tailLines(file, SUBAGENT_TAIL_BYTES))
      return {
        agentId,
        agentType: meta.agentType,
        description: meta.description,
        runningTool: activity.runningTool,
        toolDetail: activity.toolDetail,
        updatedAt: mtimeMs,
      }
    }),
  )
}

/** The state read for one session: the main transcript's activity and its active subagents. */
interface SessionReading {
  activity: SessionActivity
  subagents: SubagentView[]
}

/**
 * A full state snapshot: live sessions, paired windows, activity, active subagents.
 *
 * @param heldAgents the `agentId` of the subagents that have a pending decision now (the daemon takes
 * them from the broker). They are included even when they wrote long ago; see `readSubagents`.
 */
export async function scanSessions(
  claudeDir: string,
  probe: ProcessProbe,
  now: number = Date.now(),
  heldAgents: ReadonlySet<string> = new Set(),
): Promise<{
  sessions: LiveSession[]
  activities: Map<string, SessionActivity>
  /** Holds only the sessions with at least one active subagent. */
  subagents: Map<string, SubagentView[]>
}> {
  // The probe's synchronous answers come from its latest snapshot, so it is refreshed first, in
  // parallel with the file reads. The refresh does not block and never rejects.
  const [records, locks] = await Promise.all([readRecords(claudeDir), readLocks(claudeDir), probe.refresh()])
  const sessions = resolveLiveSessions(records, locks, probe)

  const entries = await Promise.all(
    sessions.map(async ({ record }): Promise<[string, SessionReading]> => {
      try {
        const transcript = await findTranscriptPath(claudeDir, record.sessionId)
        if (transcript === undefined) return [record.sessionId, { activity: {}, subagents: [] }]
        const [lines, subagents] = await Promise.all([tailLines(transcript), readSubagents(transcript, now, heldAgents)])
        return [record.sessionId, { activity: readActivityFromLines(lines), subagents }]
      } catch (error) {
        // Defence in depth. `Promise.all` would drop the whole scan on a single rejection, so EVERY
        // session would vanish from the list because of one unreadable transcript. The callees are
        // best-effort already; this guards against a later change bringing in something that throws.
        console.error(`[scan] activity read failed for ${record.sessionId}`, error)
        return [record.sessionId, { activity: {}, subagents: [] }]
      }
    }),
  )

  return {
    sessions,
    activities: new Map(entries.map(([id, reading]) => [id, reading.activity])),
    subagents: new Map(
      entries.filter(([, reading]) => reading.subagents.length > 0).map(([id, reading]) => [id, reading.subagents]),
    ),
  }
}
