/**
 * The subagents' files beside the session transcript (measured, Claude Code 2.1.30x, 2026-10-21):
 *
 *   projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl      ← the subagent's transcript
 *   projects/<project>/<sessionId>/subagents/agent-<agentId>.meta.json  ← type, description, finished
 *
 * An undocumented format. This module is IO-free: the daemon reads, this module parses and picks.
 */

import { flatText, isRecord } from './guards.js'

/**
 * How long a subagent counts as active after its last transcript write when its meta does not say
 * it is finished. A crashed subagent (or one run by an older version) never writes `finished`, and
 * without this it would "run" forever. 5 minutes: a subagent writes nothing during a long Bash or
 * build run and should not disappear meanwhile; one silent for longer is no longer of interest.
 */
export const SUBAGENT_STALE_MS = 5 * 60_000

/**
 * At most this many of a session's most recently written unfinished subagents get their transcript
 * tail read. The poll runs about every 3 s over 15 to 20 sessions, so a session's read is at most
 * this many transcript tails (the meta files are bounded by `SUBAGENT_META_LIMIT`).
 */
export const SUBAGENT_SCAN_LIMIT = 3

/**
 * At most this many meta files of subagents written within the stale window are read per session.
 * `SUBAGENT_SCAN_LIMIT` applies AFTER the finished subagents are filtered out; otherwise a few
 * just-finished subagents would hide one still running, only because they wrote later. A meta file
 * is small; this limit only keeps a session with many subagents from reading dozens of files on
 * every poll.
 */
export const SUBAGENT_META_LIMIT = 10

/** How much of a subagent transcript's end is read: plenty for the last tool_use. */
export const SUBAGENT_TAIL_BYTES = 64 * 1024

export interface SubagentMeta {
  agentType?: string | undefined
  description?: string | undefined
  /** The id of the `Agent` tool_use in the main transcript. */
  toolUseId?: string | undefined
  /** Only an explicit `finished: true` means finished; a running subagent has no such key. */
  finished: boolean
}

export interface SubagentFile {
  agentId: string
  mtimeMs: number
}

/** The parsed content of `meta.json`. A missing or mistyped field means no information. Never throws. */
export function parseSubagentMeta(raw: unknown): SubagentMeta {
  if (!isRecord(raw)) return { finished: false }
  const meta: SubagentMeta = { finished: raw['finished'] === true }
  const agentType = flatText(raw['agentType'])
  const description = flatText(raw['description'])
  const toolUseId = flatText(raw['toolUseId'])
  if (agentType !== undefined) meta.agentType = agentType
  if (description !== undefined) meta.description = description
  if (toolUseId !== undefined) meta.toolUseId = toolUseId
  return meta
}

/**
 * The meta file name of a subagent, `agent-<agentId>.meta.json`. The directory it sits in is
 * `subagentsDirOf` in `paths.ts`, which needs `node:path` and so cannot live in this module.
 */
export function subagentMetaFile(agentId: string): string {
  return `agent-${agentId}.meta.json`
}

/** `agent-<agentId>.jsonl` → `<agentId>`; `undefined` for any other file name (the meta file too). */
export function subagentIdFromFile(fileName: string): string | undefined {
  const match = /^agent-(.+)\.jsonl$/.exec(fileName)
  return match?.[1]
}

/**
 * The subagent files worth reading: the `limit` most recent of those written within `staleMs`,
 * newest first. An `mtime` in the future (clock skew) counts as fresh.
 */
export function pickRecentSubagentFiles<T extends SubagentFile>(
  files: readonly T[],
  now: number,
  limit: number = SUBAGENT_SCAN_LIMIT,
  staleMs: number = SUBAGENT_STALE_MS,
): T[] {
  return files
    .filter((file) => now - file.mtimeMs <= staleMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
}
